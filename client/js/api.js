/**
 * PrepDeck - Core Client API Helper & State Management
 * Clean SaaS architecture with resilient error handling and resource cleanup
 */

const API_BASE_URL = window.location.protocol.startsWith('http') 
  ? `${window.location.origin}/api` 
  : 'http://localhost:5000/api';

class Api {
  constructor() {
    this.token = localStorage.getItem('prepdeck_token') || null;
    this.syncPendingSession();
  }

  isAuthenticated() {
    return !!this.token && this.token !== 'null' && this.token !== 'undefined';
  }

  requireAuth() {
    if (!this.isAuthenticated()) {
      this.logout();
      return false;
    }
    return true;
  }

  async syncPendingSession() {
    try {
      const pending = localStorage.getItem('prepdeck_pending_session');
      if (pending && this.token) {
        const sessionData = JSON.parse(pending);
        if (sessionData && sessionData.durationMs > 2000) {
          sessionData.endTime = Date.now();
          await this.saveStudySession(sessionData);
        }
        localStorage.removeItem('prepdeck_pending_session');
      }
    } catch (e) {
      console.warn("Could not sync pending study session:", e.message);
      localStorage.removeItem('prepdeck_pending_session');
    }
  }

  getHeaders() {
    const headers = {
      'Content-Type': 'application/json'
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  getAuthHeaders() {
    const headers = {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  handleUnauthorized(res) {
    if (res.status === 401) {
      this.logout();
      return true;
    }
    return false;
  }

  async login(email, password) {
    const res = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || 'Invalid email or password');
    }
    this.token = data.token;
    localStorage.setItem('prepdeck_token', data.token);
    localStorage.setItem('prepdeck_user', JSON.stringify(data));
    return data;
  }

  async register(name, email, password) {
    const res = await fetch(`${API_BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || 'Registration failed');
    }
    this.token = data.token;
    localStorage.setItem('prepdeck_token', data.token);
    localStorage.setItem('prepdeck_user', JSON.stringify(data));
    return data;
  }

  logout() {
    // 1. Notify backend logout endpoint
    try {
      if (this.token) {
        fetch(`${API_BASE_URL}/auth/logout`, {
          method: 'POST',
          headers: this.getAuthHeaders()
        }).catch(() => {});
      }
    } catch (e) {}

    // 2. Invalidate memory token
    this.token = null;

    // 3. Clear authentication, navigation stack, and session storage
    try {
      localStorage.removeItem('prepdeck_token');
      localStorage.removeItem('prepdeck_user');
      localStorage.removeItem('prepdeck_pending_session');
      sessionStorage.removeItem('prepdeck_nav_stack');
      sessionStorage.clear();
      // Clear client-accessible cookies
      document.cookie.split(";").forEach(c => {
        document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date(0).toUTCString() + ";path=/");
      });
    } catch (e) {
      console.warn("Storage cleanup warning:", e);
    }

    // 4. Stop active webcam stream if running
    if (window.__activeWebcamStream) {
      try {
        window.__activeWebcamStream.getTracks().forEach(track => track.stop());
      } catch (e) {}
      window.__activeWebcamStream = null;
    }

    // 5. Cancel speech synthesis & speech recognition
    if (window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
    if (window.__activeSpeechRecognition) {
      try { window.__activeSpeechRecognition.abort(); } catch (e) {}
      window.__activeSpeechRecognition = null;
    }

    // 6. Clear active intervals/timers
    if (window.__activeIntervals && Array.isArray(window.__activeIntervals)) {
      window.__activeIntervals.forEach(id => clearInterval(id));
      window.__activeIntervals = [];
    }

    // 7. Redirect cleanly to login, replacing current history entry so Back does not restore protected page
    window.location.replace('auth.html?mode=login');
  }

  async getDashboardStats() {
    const res = await fetch(`${API_BASE_URL}/study/stats`, { headers: this.getHeaders() });
    if (this.handleUnauthorized(res)) return {};
    return res.json();
  }

  async getDocuments(type) {
    const url = type ? `${API_BASE_URL}/docs?type=${encodeURIComponent(type)}` : `${API_BASE_URL}/docs`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (this.handleUnauthorized(res)) return [];
    return res.json();
  }

  async uploadDocument(formData) {
    if (!this.token) {
      this.logout();
      throw new Error('Please log in to upload documents.');
    }
    const res = await fetch(`${API_BASE_URL}/docs/upload`, {
      method: 'POST',
      headers: this.getAuthHeaders(), // Do NOT set Content-Type so browser sets boundary
      body: formData
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) {
        this.logout();
      }
      throw new Error(data.message || 'Document upload failed. Please try again.');
    }
    return data;
  }

  async deleteDocument(id) {
    const res = await fetch(`${API_BASE_URL}/docs/${id}`, {
      method: 'DELETE',
      headers: this.getHeaders()
    });
    if (this.handleUnauthorized(res)) return {};
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Failed to delete document');
    return data;
  }

  async fetchDocumentBlob(id) {
    const res = await fetch(`${API_BASE_URL}/docs/${id}/file`, {
      headers: this.getHeaders()
    });
    if (!res.ok) {
      if (this.handleUnauthorized(res)) return null;
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Failed to fetch document');
    }
    return await res.blob();
  }

  async saveStudySession(sessionData) {
    const res = await fetch(`${API_BASE_URL}/study/session`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(sessionData)
    });
    if (this.handleUnauthorized(res)) return {};
    return res.json();
  }

  async generateQuestions(payload) {
    const body = typeof payload === 'object' ? payload : { documentId: payload };
    const res = await fetch(`${API_BASE_URL}/study/generate-questions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body)
    });
    if (this.handleUnauthorized(res)) return {};
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Failed to generate questions');
    return data;
  }

  async generateFollowUp(payload) {
    const res = await fetch(`${API_BASE_URL}/study/follow-up`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(payload)
    });
    if (this.handleUnauthorized(res)) return {};
    return res.json();
  }

  async evaluateSession(payload) {
    const res = await fetch(`${API_BASE_URL}/study/evaluate`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(payload)
    });
    if (this.handleUnauthorized(res)) return {};
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Evaluation failed');
    return data;
  }

  async getInterviewHistory() {
    const res = await fetch(`${API_BASE_URL}/study/interviews`, { headers: this.getHeaders() });
    if (this.handleUnauthorized(res)) return [];
    return res.json();
  }

  async generateQuiz(documentId, difficultyLevel = 'medium') {
    const res = await fetch(`${API_BASE_URL}/study/generate-quiz`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ documentId, difficultyLevel })
    });
    if (this.handleUnauthorized(res)) return {};
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Quiz generation failed');
    return data;
  }

  async evaluateQuiz(payload) {
    const res = await fetch(`${API_BASE_URL}/study/evaluate-quiz`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(payload)
    });
    if (this.handleUnauthorized(res)) return {};
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Quiz evaluation failed');
    return data;
  }

  async getQuizHistory(documentId) {
    const res = await fetch(`${API_BASE_URL}/study/quiz-history/${documentId}`, { headers: this.getHeaders() });
    if (this.handleUnauthorized(res)) return [];
    return res.json();
  }

  async getStudySessions() {
    const res = await fetch(`${API_BASE_URL}/study/sessions`, { headers: this.getHeaders() });
    if (this.handleUnauthorized(res)) return [];
    return res.json();
  }

  async getAllQuizHistory() {
    const res = await fetch(`${API_BASE_URL}/study/quizzes`, { headers: this.getHeaders() });
    if (this.handleUnauthorized(res)) return [];
    return res.json();
  }

  async downloadDocument(id, filename) {
    if (!this.token) {
      this.logout();
      throw new Error('Please log in to download documents.');
    }

    try {
      // 1. Primary Method: Direct authenticated link trigger.
      // Retains user gesture context so Chrome/Edge/Safari won't block it.
      // Streams directly to disk with native browser progress indicator without loading 50MB into JS heap.
      const token = encodeURIComponent(this.token);
      const downloadUrl = `${API_BASE_URL}/docs/${id}/file?download=true&token=${token}`;
      
      const a = document.createElement('a');
      a.href = downloadUrl;
      if (filename) a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        if (a.parentNode) a.parentNode.removeChild(a);
      }, 1500);
      return true;
    } catch (directErr) {
      console.warn("Direct download link trigger failed, attempting fetch blob fallback:", directErr);
      // 2. Secondary Fallback: Fetch blob download
      const res = await fetch(`${API_BASE_URL}/docs/${id}/file?download=true`, {
        headers: this.getAuthHeaders()
      });
      if (this.handleUnauthorized(res)) return false;
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Failed to download document');
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = filename || 'document.pdf';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        window.URL.revokeObjectURL(url);
        if (a.parentNode) a.parentNode.removeChild(a);
      }, 2000);
      return true;
    }
  }

  async updateProfile(profileData) {
    const res = await fetch(`${API_BASE_URL}/auth/profile`, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify(profileData)
    });
    if (this.handleUnauthorized(res)) return {};
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Profile update failed');
    localStorage.setItem('prepdeck_user', JSON.stringify(data));
    if (data.token) {
      this.token = data.token;
      localStorage.setItem('prepdeck_token', data.token);
    }
    return data;
  }
}

// Navigation History Tracker & Stateful Back Navigation (Requirement 3 & 6)
(function initNavigationTracker() {
  if (typeof window === 'undefined') return;
  
  const currentPath = window.location.pathname.split('/').pop() + window.location.search;
  const isAuthOrLanding = currentPath.includes('auth.html') || currentPath.includes('index.html') || currentPath === '';
  
  if (!isAuthOrLanding && localStorage.getItem('prepdeck_token')) {
    try {
      let stack = JSON.parse(sessionStorage.getItem('prepdeck_nav_stack') || '[]');
      if (!Array.isArray(stack)) stack = [];
      
      // Prevent consecutive duplicate pushes on refresh
      if (stack.length === 0 || stack[stack.length - 1] !== currentPath) {
        stack.push(currentPath);
        if (stack.length > 25) stack.shift();
        sessionStorage.setItem('prepdeck_nav_stack', JSON.stringify(stack));
      }
    } catch(e) {}
  }
})();

window.smartBack = function(fallbackUrl = 'dashboard.html') {
  try {
    let stack = JSON.parse(sessionStorage.getItem('prepdeck_nav_stack') || '[]');
    const currentPath = window.location.pathname.split('/').pop() + window.location.search;
    
    // Pop current page if on top of stack
    if (stack.length > 0 && stack[stack.length - 1] === currentPath) {
      stack.pop();
    }

    // Traverse back to find previous distinct in-app page
    while (stack.length > 0) {
      const prev = stack.pop();
      if (prev && prev !== currentPath && !prev.includes('auth.html') && !prev.includes('index.html')) {
        sessionStorage.setItem('prepdeck_nav_stack', JSON.stringify(stack));
        window.location.href = prev;
        return;
      }
    }
  } catch(e) {}

  // Fallback to referrer if valid in-app URL
  if (document.referrer) {
    try {
      const refUrl = new URL(document.referrer);
      const refPage = refUrl.pathname.split('/').pop() + refUrl.search;
      const currentPage = window.location.pathname.split('/').pop() + window.location.search;
      if (refUrl.origin === window.location.origin && 
          refPage !== currentPage && 
          !refPage.includes('auth.html') && 
          !refPage.includes('index.html')) {
        window.location.href = refPage;
        return;
      }
    } catch(e) {}
  }

  // Safe fallback default
  window.location.href = fallbackUrl || 'dashboard.html';
};

// Protection against Back-Forward Cache (bfcache) exposing protected views after logout
window.addEventListener('pageshow', (event) => {
  const currentPath = window.location.pathname.split('/').pop();
  const isAuthOrLanding = currentPath.includes('auth.html') || currentPath.includes('index.html') || currentPath === '';
  const token = localStorage.getItem('prepdeck_token');
  if (!token && !isAuthOrLanding) {
    window.location.replace('auth.html?mode=login');
  }
});

// Global Singletons
const api = new Api();
window.api = api;
window.logout = () => api.logout();

// Toast Notification System
window.showToast = function(message, type = 'info', duration = 3500) {
  let container = document.getElementById('prepdeck-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'prepdeck-toast-container';
    container.className = 'fixed top-5 right-5 z-[9999] flex flex-col gap-2 max-w-sm pointer-events-none';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  const typeStyles = {
    success: 'bg-emerald-50 border-emerald-200 text-emerald-900 icon-emerald-600 fa-circle-check',
    error: 'bg-rose-50 border-rose-200 text-rose-900 icon-rose-600 fa-circle-exclamation',
    warning: 'bg-amber-50 border-amber-200 text-amber-900 icon-amber-600 fa-triangle-exclamation',
    info: 'bg-indigo-50 border-indigo-200 text-indigo-900 icon-indigo-600 fa-circle-info'
  };
  const [bgClass, borderClass, textClass, iconClass, iconName] = (typeStyles[type] || typeStyles.info).split(' ');

  toast.className = `flex items-center gap-3 px-4 py-3 rounded-xl border shadow-lg text-sm font-medium transition-all duration-300 transform translate-y-[-10px] opacity-0 pointer-events-auto ${bgClass} ${borderClass} ${textClass}`;
  toast.innerHTML = `
    <i class="fa-solid ${iconName} ${iconClass.replace('icon-', 'text-')} shrink-0 text-base"></i>
    <span class="flex-1">${message}</span>
    <button class="text-slate-400 hover:text-slate-700 ml-2" onclick="this.parentElement.remove()">
      <i class="fa-solid fa-xmark text-xs"></i>
    </button>
  `;

  container.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-[-10px]', 'opacity-0');
  });

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-x-full');
    setTimeout(() => toast.remove(), 300);
  }, duration);
};

// Profile Modal Management (Modern Light SaaS Theme)
window.openProfileModal = function() {
  let modal = document.getElementById('profile-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'profile-modal';
    modal.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm hidden transition-opacity duration-300 opacity-0 p-4';
    modal.innerHTML = `
      <div class="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 w-full max-w-md shadow-2xl relative overflow-hidden transform scale-95 transition-all duration-300">
        <div class="flex justify-between items-center mb-6">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600">
              <i class="fa-solid fa-user-graduate text-base"></i>
            </div>
            <div>
              <h3 class="text-lg font-bold text-slate-900">Scholar Profile</h3>
              <p class="text-xs text-slate-500">Manage your personal credentials</p>
            </div>
          </div>
          <button onclick="closeProfileModal()" class="w-8 h-8 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 flex items-center justify-center transition-colors">
            <i class="fa-solid fa-xmark text-base"></i>
          </button>
        </div>

        <div id="profile-alert" class="hidden mb-4 p-3 rounded-xl text-xs font-semibold border"></div>

        <form id="profile-form" onsubmit="handleProfileSubmit(event)" class="space-y-4">
          <div>
            <label class="block text-xs font-semibold text-slate-700 mb-1.5">Full Name</label>
            <input type="text" id="profile-name" required class="w-full bg-slate-50 border border-slate-200 text-slate-900 text-sm font-medium rounded-xl py-2.5 px-3.5 focus:bg-white focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all placeholder-slate-400">
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-700 mb-1.5">Email Address</label>
            <input type="email" id="profile-email" required class="w-full bg-slate-50 border border-slate-200 text-slate-900 text-sm font-medium rounded-xl py-2.5 px-3.5 focus:bg-white focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all placeholder-slate-400">
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-700 mb-1.5">New Password <span class="text-slate-400 font-normal">(leave blank to keep current)</span></label>
            <input type="password" id="profile-password" class="w-full bg-slate-50 border border-slate-200 text-slate-900 text-sm font-medium rounded-xl py-2.5 px-3.5 focus:bg-white focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all placeholder-slate-400" placeholder="••••••••">
          </div>
          <div class="pt-2">
            <div class="bg-indigo-50/60 border border-indigo-100 rounded-xl p-3 flex items-center justify-between">
              <div class="flex items-center gap-2.5">
                <i class="fa-solid fa-circle-check text-indigo-600 text-sm"></i>
                <span class="text-xs font-bold text-indigo-900">Scholar Pro Tier</span>
              </div>
              <span class="text-[11px] font-semibold text-indigo-600 bg-white px-2 py-0.5 rounded-md border border-indigo-100">Active</span>
            </div>
          </div>
          <div class="pt-3 flex gap-3">
            <button type="button" onclick="closeProfileModal()" class="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-700 text-xs font-bold hover:bg-slate-50 transition-colors">
              Cancel
            </button>
            <button type="submit" id="profile-save-btn" class="flex-1 py-2.5 rounded-xl bg-indigo-600 text-white text-xs font-bold hover:bg-indigo-700 shadow-sm transition-all flex justify-center items-center gap-2">
              Save Changes
            </button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeProfileModal();
    });
  }

  const nameInput = document.getElementById('profile-name');
  const emailInput = document.getElementById('profile-email');
  const pwdInput = document.getElementById('profile-password');
  const alertDiv = document.getElementById('profile-alert');
  
  alertDiv.className = 'hidden mb-4 p-3 rounded-xl text-xs font-semibold border';
  pwdInput.value = '';

  try {
    const userStr = localStorage.getItem('prepdeck_user');
    if (userStr) {
      const user = JSON.parse(userStr);
      nameInput.value = user.name || '';
      emailInput.value = user.email || '';
    }
  } catch(e) {
    console.error("Error reading cached user profile:", e);
  }

  modal.classList.remove('hidden');
  setTimeout(() => {
    modal.classList.add('opacity-100');
    modal.querySelector('div').classList.remove('scale-95');
    modal.querySelector('div').classList.add('scale-100');
  }, 10);
};

window.closeProfileModal = function() {
  const modal = document.getElementById('profile-modal');
  if (!modal) return;
  modal.classList.remove('opacity-100');
  modal.querySelector('div').classList.remove('scale-100');
  modal.querySelector('div').classList.add('scale-95');
  setTimeout(() => {
    modal.classList.add('hidden');
  }, 250);
};

window.handleProfileSubmit = async function(event) {
  event.preventDefault();
  const name = document.getElementById('profile-name').value;
  const email = document.getElementById('profile-email').value;
  const password = document.getElementById('profile-password').value;
  const alertDiv = document.getElementById('profile-alert');
  const saveBtn = document.getElementById('profile-save-btn');

  alertDiv.className = 'hidden';
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

  try {
    const payload = { name, email };
    if (password && password.trim()) {
      payload.password = password;
    }
    const updated = await api.updateProfile(payload);
    
    alertDiv.innerText = 'Profile updated successfully!';
    alertDiv.className = 'mb-4 p-3 rounded-xl text-xs font-semibold border border-emerald-200 bg-emerald-50 text-emerald-800';
    
    // Update active avatars/names in UI
    const sidebarName = document.getElementById('sidebar-name');
    if (sidebarName) sidebarName.innerText = updated.name.split(' ')[0] || 'Scholar';
    
    const topAvatar = document.getElementById('top-avatar');
    if (topAvatar) topAvatar.innerHTML = updated.name ? updated.name.charAt(0).toUpperCase() : '?';

    window.showToast('Profile updated successfully', 'success');

    setTimeout(() => {
      closeProfileModal();
    }, 900);
  } catch(e) {
    alertDiv.innerText = e.message || 'Error updating profile';
    alertDiv.className = 'mb-4 p-3 rounded-xl text-xs font-semibold border border-rose-200 bg-rose-50 text-rose-800';
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = 'Save Changes';
  }
};
