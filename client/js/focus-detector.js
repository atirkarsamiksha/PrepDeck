/**
 * PrepDeck Focus & Drowsiness Computer-Vision Engine
 * Uses local Face-API models (TinyFaceDetector + FaceLandmark68Net)
 * Computes:
 *  1. Face Presence & Visibility (with tracking hysteresis)
 *  2. Real Eye Aspect Ratio (EAR) for Drowsiness & Prolonged Eye Closure Detection
 *  3. 3D Head Orientation (Yaw & Pitch) for Off-Screen Distraction Detection
 *  4. Telemetry Session Summary (Duration, Face-Visible %, Events Timeline)
 */

class FocusDetector {
  constructor(options = {}) {
    this.videoElement = options.videoElement || null;
    this.overlayCanvas = options.overlayCanvas || null;
    this.modelsPath = options.modelsPath || '/models';
    
    // Callbacks
    this.onMetricsUpdate = options.onMetricsUpdate || null;
    this.onWarning = options.onWarning || null;
    this.onStatusChange = options.onStatusChange || null;

    // Configuration Thresholds
    this.EAR_CLOSED_THRESHOLD = options.earClosedThreshold || 0.20; // Eye closed threshold
    this.DROWSINESS_DURATION_MS = options.drowsinessDurationMs || 1800; // Prolonged closure time
    this.HEAD_DOWN_DURATION_MS = options.headDownDurationMs || 2200; // Downward tilt time
    this.DISTRACTION_DURATION_MS = options.distractionDurationMs || 2000; // Looking away time
    this.ALERT_COOLDOWN_MS = options.alertCooldownMs || 12000; // Audio alert cooldown

    // State
    this.isInitialized = false;
    this.isRunning = false;
    this.isPaused = false;
    this.soundAlertEnabled = options.soundAlertEnabled !== false;

    // Detection loop interval
    this.loopInterval = null;
    this.fpsIntervalMs = options.fpsIntervalMs || 400; // ~2.5 frames per sec for great responsiveness & low CPU

    // Tracking state trackers
    this.consecutiveMissingFrames = 0;
    this.eyeClosedStartTime = null;
    this.headAwayStartTime = null;
    this.headDownStartTime = null;
    this.lastAlertTime = 0;
    this.recentClosures = []; // Timestamps of closures in last 30s

    // Session Telemetry
    this.session = {
      startTime: 0,
      totalDurationMs: 0,
      faceVisibleMs: 0,
      focusedMs: 0,
      distractedMs: 0,
      drowsinessEventsCount: 0,
      distractionEventsCount: 0,
      interruptionsCount: 0,
      timeline: []
    };

    this.currentMetrics = {
      faceDetected: false,
      ear: 0,
      eyesClosed: false,
      headPose: 'centered', // 'centered', 'turned_left', 'turned_right', 'downward'
      isDrowsy: false,
      isDistracted: false,
      status: 'calibrating' // 'focused', 'drowsy', 'distracted', 'away', 'calibrating', 'paused'
    };
  }

  /**
   * Load local model weights once
   */
  async loadModels() {
    if (this.isInitialized) return true;
    if (typeof faceapi === 'undefined') {
      throw new Error('face-api.js library is not loaded on the page.');
    }

    try {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(this.modelsPath),
        faceapi.nets.faceLandmark68Net.loadFromUri(this.modelsPath)
      ]);
      this.isInitialized = true;
      return true;
    } catch (err) {
      console.error('Failed to load Face-API local models from ' + this.modelsPath, err);
      throw err;
    }
  }

  /**
   * Start tracking on video element
   */
  async start(videoElement) {
    if (videoElement) this.videoElement = videoElement;
    if (!this.videoElement) throw new Error('No video element provided for focus monitoring.');

    await this.loadModels();

    this.isRunning = true;
    this.isPaused = false;
    this.session.startTime = Date.now();
    this.lastLoopTime = Date.now();

    if (this.loopInterval) clearInterval(this.loopInterval);
    this.loopInterval = setInterval(() => this.processFrame(), this.fpsIntervalMs);

    if (this.onStatusChange) this.onStatusChange('focused', 'Session Started');
  }

  /**
   * Pause focus monitoring
   */
  pause() {
    this.isPaused = true;
    this.currentMetrics.status = 'paused';
    if (this.onMetricsUpdate) this.onMetricsUpdate(this.currentMetrics);
    if (this.onStatusChange) this.onStatusChange('paused', 'Monitoring Paused');
  }

  /**
   * Resume focus monitoring
   */
  resume() {
    this.isPaused = false;
    this.lastLoopTime = Date.now();
    this.currentMetrics.status = 'focused';
    if (this.onStatusChange) this.onStatusChange('focused', 'Monitoring Resumed');
  }

  /**
   * Stop monitoring & cleanup
   */
  stop() {
    this.isRunning = false;
    if (this.loopInterval) {
      clearInterval(this.loopInterval);
      this.loopInterval = null;
    }

    if (this.overlayCanvas) {
      const ctx = this.overlayCanvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    }

    if ('speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch(e) {}
    }

    return this.getSessionSummary();
  }

  /**
   * Get final session summary
   */
  getSessionSummary() {
    const total = this.session.totalDurationMs || (Date.now() - (this.session.startTime || Date.now()));
    const visible = this.session.faceVisibleMs;
    const focusPct = total > 0 ? Math.min(100, Math.round((this.session.focusedMs / total) * 100)) : 100;
    const faceVisiblePct = total > 0 ? Math.min(100, Math.round((visible / total) * 100)) : 100;

    return {
      totalDurationMs: total,
      faceVisibleMs: visible,
      focusedMs: this.session.focusedMs,
      distractedMs: this.session.distractedMs,
      focusPercentage: focusPct,
      faceVisiblePercentage: faceVisiblePct,
      drowsinessEventsCount: this.session.drowsinessEventsCount,
      distractionEventsCount: this.session.distractionEventsCount,
      interruptionsCount: this.session.interruptionsCount,
      timeline: this.session.timeline
    };
  }

  /**
   * Single frame computer vision processing
   */
  async processFrame() {
    if (!this.isRunning || this.isPaused || !this.videoElement || !this.videoElement.videoWidth) {
      return;
    }

    const now = Date.now();
    const dt = Math.min(now - (this.lastLoopTime || now), 1000);
    this.lastLoopTime = now;
    this.session.totalDurationMs += dt;

    try {
      const detection = await faceapi.detectSingleFace(
        this.videoElement,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.38 })
      ).withFaceLandmarks(true);

      if (this.overlayCanvas) {
        if (this.overlayCanvas.width !== this.videoElement.videoWidth) {
          this.overlayCanvas.width = this.videoElement.videoWidth;
          this.overlayCanvas.height = this.videoElement.videoHeight;
        }
      }

      if (!detection) {
        this.handleFaceAbsent(now, dt);
        return;
      }

      this.handleFacePresent(detection, now, dt);

    } catch (err) {
      console.warn('FocusDetector frame error:', err);
    }
  }

  /**
   * Handle case where face is NOT detected in frame
   */
  handleFaceAbsent(now, dt) {
    this.consecutiveMissingFrames++;
    this.session.distractedMs += dt;

    // Require 2 consecutive missed frames (approx 800ms) to avoid single-frame flickering
    if (this.consecutiveMissingFrames >= 2) {
      this.currentMetrics.faceDetected = false;
      this.currentMetrics.ear = 0;
      this.currentMetrics.eyesClosed = false;
      this.currentMetrics.headPose = 'unknown';
      this.currentMetrics.status = 'away';

      if (this.consecutiveMissingFrames === 2) {
        this.session.interruptionsCount++;
        this.addTimelineEvent('away', 'User stepped away or face not visible');
      }

      this.triggerWarning('warning', 'Face not detected. Please face the camera.', 'face_absent', now);

      if (this.onMetricsUpdate) this.onMetricsUpdate(this.currentMetrics);
      if (this.onStatusChange) this.onStatusChange('away', 'Face Not Detected');
    }

    // Clear canvas
    if (this.overlayCanvas) {
      const ctx = this.overlayCanvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    }
  }

  /**
   * Handle case where face & landmarks are detected
   */
  handleFacePresent(detection, now, dt) {
    this.consecutiveMissingFrames = 0;
    this.session.faceVisibleMs += dt;
    this.currentMetrics.faceDetected = true;

    const landmarks = detection.landmarks;
    const positions = landmarks.positions;

    // 1. Calculate Real Eye Aspect Ratio (EAR)
    // Left eye landmarks: 36, 37, 38, 39, 40, 41
    const leftEar = this.computeEAR(positions, 36, 37, 38, 39, 40, 41);
    // Right eye landmarks: 42, 43, 44, 45, 46, 47
    const rightEar = this.computeEAR(positions, 42, 43, 44, 45, 46, 47);
    const avgEar = (leftEar + rightEar) / 2;
    this.currentMetrics.ear = Math.round(avgEar * 100) / 100;

    const eyesClosed = avgEar < this.EAR_CLOSED_THRESHOLD;
    this.currentMetrics.eyesClosed = eyesClosed;

    // 2. Calculate Head Orientation (Yaw & Pitch)
    const headPose = this.estimateHeadPose(positions);
    this.currentMetrics.headPose = headPose;

    // 3. Drowsiness Evaluation (Prolonged Eye Closure)
    let isDrowsy = false;
    if (eyesClosed) {
      if (!this.eyeClosedStartTime) {
        this.eyeClosedStartTime = now;
      } else {
        const closedDuration = now - this.eyeClosedStartTime;
        if (closedDuration >= this.DROWSINESS_DURATION_MS) {
          isDrowsy = true;
          this.session.drowsinessEventsCount++;
          this.recentClosures.push(now);
          this.addTimelineEvent('drowsiness', `Prolonged eye closure (${Math.round(closedDuration / 1000)}s)`);
          this.triggerWarning('danger', 'Possible drowsiness detected! Eyes closed for >1.5s.', 'drowsiness', now);
        }
      }
    } else {
      this.eyeClosedStartTime = null;
    }

    // Clean up recent closures window (30s)
    this.recentClosures = this.recentClosures.filter(t => (now - t) < 30000);
    if (this.recentClosures.length >= 3 && !isDrowsy) {
      isDrowsy = true;
      this.triggerWarning('warning', 'High eye fatigue detected. Repeated micro-closures observed.', 'fatigue', now);
    }
    this.currentMetrics.isDrowsy = isDrowsy;

    // 4. Distraction Evaluation (Head Turned or Head Down)
    let isDistracted = false;
    if (headPose === 'turned_left' || headPose === 'turned_right') {
      if (!this.headAwayStartTime) {
        this.headAwayStartTime = now;
      } else {
        const turnedDuration = now - this.headAwayStartTime;
        if (turnedDuration >= this.DISTRACTION_DURATION_MS) {
          isDistracted = true;
          this.session.distractionEventsCount++;
          this.addTimelineEvent('distraction', `Turned away from screen (${headPose})`);
          this.triggerWarning('warning', 'Please look forward towards the interview screen.', 'turned_away', now);
        }
      }
    } else {
      this.headAwayStartTime = null;
    }

    if (headPose === 'downward') {
      if (!this.headDownStartTime) {
        this.headDownStartTime = now;
      } else {
        const downDuration = now - this.headDownStartTime;
        if (downDuration >= this.HEAD_DOWN_DURATION_MS) {
          isDistracted = true;
          this.session.distractionEventsCount++;
          this.addTimelineEvent('distraction', 'Sustained downward head tilt / slouching');
          this.triggerWarning('warning', 'Head tilt detected. Maintain upright eye-level position.', 'head_down', now);
        }
      }
    } else {
      this.headDownStartTime = null;
    }
    this.currentMetrics.isDistracted = isDistracted;

    // 5. Determine Overall State
    if (isDrowsy) {
      this.currentMetrics.status = 'drowsy';
      this.session.distractedMs += dt;
      if (this.onStatusChange) this.onStatusChange('drowsy', 'Drowsiness Risk');
    } else if (isDistracted) {
      this.currentMetrics.status = 'distracted';
      this.session.distractedMs += dt;
      if (this.onStatusChange) this.onStatusChange('distracted', 'Off-Screen Attention');
    } else {
      this.currentMetrics.status = 'focused';
      this.session.focusedMs += dt;
      if (this.onStatusChange) this.onStatusChange('focused', 'Focused');
    }

    // 6. Draw subtle visual landmarks overlay if canvas available
    this.drawLandmarksOverlay(detection, isDrowsy, isDistracted);

    // 7. Emit metrics
    if (this.onMetricsUpdate) {
      this.onMetricsUpdate({ ...this.currentMetrics });
    }
  }

  /**
   * Euclidean distance between two 2D points
   */
  dist(p1, p2) {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Compute Eye Aspect Ratio (EAR)
   * Formula: (||p2-p6|| + ||p3-p5||) / (2 * ||p1-p4||)
   */
  computeEAR(pts, p1, p2, p3, p4, p5, p6) {
    const vertical1 = this.dist(pts[p2], pts[p6]);
    const vertical2 = this.dist(pts[p3], pts[p5]);
    const horizontal = this.dist(pts[p1], pts[p4]);

    if (horizontal === 0) return 0.28;
    return (vertical1 + vertical2) / (2.0 * horizontal);
  }

  /**
   * Estimate 3D Head Orientation from facial landmarks
   */
  estimateHeadPose(pts) {
    const noseTip = pts[30];
    const leftEyeCorner = pts[36];
    const rightEyeCorner = pts[45];
    const chin = pts[8];
    const noseBridge = pts[27];

    // Yaw (Horizontal head turn left/right)
    const distToLeftEye = this.dist(noseTip, leftEyeCorner);
    const distToRightEye = this.dist(noseTip, rightEyeCorner);

    if (distToRightEye > 0) {
      const yawRatio = distToLeftEye / distToRightEye;
      if (yawRatio < 0.45) return 'turned_right'; // In flipped video, right eye is compressed
      if (yawRatio > 2.2) return 'turned_left';
    }

    // Pitch (Vertical head tilt)
    // Vertical distance from eye bridge to nose tip vs nose tip to chin
    const upperNoseDist = Math.abs(noseTip.y - noseBridge.y);
    const lowerNoseToChin = Math.abs(chin.y - noseTip.y);

    if (lowerNoseToChin > 0) {
      const pitchRatio = upperNoseDist / lowerNoseToChin;
      if (pitchRatio > 1.25) return 'downward';
    }

    return 'centered';
  }

  /**
   * Draw lightweight feedback bounding box and eye indicators
   */
  drawLandmarksOverlay(detection, isDrowsy, isDistracted) {
    if (!this.overlayCanvas) return;
    const ctx = this.overlayCanvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

    const box = detection.detection.box;
    let strokeColor = '#10b981'; // Emerald for focused
    if (isDrowsy) strokeColor = '#ef4444'; // Red for drowsy
    else if (isDistracted) strokeColor = '#f59e0b'; // Amber for distracted

    // Draw face bounding box with rounded corners feel
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2.5;
    ctx.strokeRect(box.x, box.y, box.width, box.height);

    // Subtle eye landmark dots
    const pts = detection.landmarks.positions;
    ctx.fillStyle = strokeColor;
    // Left eye pupils/corners
    [36, 39, 42, 45].forEach(idx => {
      ctx.beginPath();
      ctx.arc(pts[idx].x, pts[idx].y, 2, 0, 2 * Math.PI);
      ctx.fill();
    });
  }

  /**
   * Trigger Warning banner with Cooldown & Voice Alert
   */
  triggerWarning(level, message, reasonCode, now) {
    if (now - this.lastAlertTime > this.ALERT_COOLDOWN_MS) {
      this.lastAlertTime = now;

      if (this.onWarning) {
        this.onWarning({ level, message, reasonCode, timestamp: now });
      }

      if (this.soundAlertEnabled && 'speechSynthesis' in window && !this.isPaused) {
        try {
          window.speechSynthesis.cancel();
          let speechText = "Please stay focused.";
          if (reasonCode === 'drowsiness') speechText = "Alert: Please wake up and stay focused on your session.";
          else if (reasonCode === 'turned_away') speechText = "Please look at the screen.";
          
          const utter = new SpeechSynthesisUtterance(speechText);
          utter.rate = 1.05;
          window.speechSynthesis.speak(utter);
        } catch(e) {}
      }
    }
  }

  /**
   * Record significant events into session history
   */
  addTimelineEvent(type, description) {
    const timeOffsetSec = Math.round((Date.now() - this.session.startTime) / 1000);
    this.session.timeline.push({
      timeOffsetSec,
      timestamp: new Date().toISOString(),
      type,
      description
    });
  }
}

window.FocusDetector = FocusDetector;
