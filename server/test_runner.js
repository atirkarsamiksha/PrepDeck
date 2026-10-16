require('dotenv').config();
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

const BASE_URL = 'http://localhost:5000/api';

let authToken = '';
let testUserId = '';
let testDocId = '';
let testUploadDocId = '';

async function runTests() {
  console.log('====================================================');
  console.log('   PREPDECK COMPREHENSIVE AUTOMATED VERIFICATION    ');
  console.log('====================================================');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  try {
    // 1. Verify Local Model Files
    console.log('\n--- 1. Local Face-API Model Assets ---');
    const modelsDir = path.join(__dirname, '../client/models');
    const requiredModels = [
      'tiny_face_detector_model-weights_manifest.json',
      'tiny_face_detector_model.bin',
      'face_landmark_68_model-weights_manifest.json',
      'face_landmark_68_model.bin'
    ];
    for (const m of requiredModels) {
      const p = path.join(modelsDir, m);
      const exists = fs.existsSync(p) && fs.statSync(p).size > 0;
      assert(exists, `Model asset present: ${m} (${exists ? fs.statSync(p).size : 0} bytes)`);
    }

    // 2. Server Health Check
    console.log('\n--- 2. Server Health Check ---');
    const healthRes = await fetch(`${BASE_URL}/health`);
    assert(healthRes.ok, `Health endpoint returned status ${healthRes.status}`);
    const healthData = await healthRes.json();
    assert(healthData.status === 'ok', `Health status is ok: ${healthData.status}`);
    assert(healthData.database === 'connected', `Database connected: ${healthData.database}`);
    assert(healthData.geminiConfigured === true, `Gemini API key configured: ${healthData.geminiConfigured}`);

    // 3. User Authentication
    console.log('\n--- 3. User Authentication & Profile ---');
    const testEmail = `test_scholar_${Date.now()}@prepdeck.test`;
    const regRes = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Automated Tester', email: testEmail, password: 'Password123!' })
    });
    assert(regRes.ok, `User registration succeeded: ${regRes.status}`);
    const regData = await regRes.json();
    authToken = regData.token;
    testUserId = regData._id;
    assert(!!authToken, `JWT token received upon registration`);

    // Profile retrieval
    const profRes = await fetch(`${BASE_URL}/auth/profile`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    assert(profRes.ok, `Profile retrieval succeeded`);
    const profData = await profRes.json();
    assert(profData.email === testEmail, `Retrieved profile email matches: ${profData.email}`);

    // Profile update
    const updateRes = await fetch(`${BASE_URL}/auth/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ name: 'Automated Tester Pro' })
    });
    assert(updateRes.ok, `Profile name update succeeded`);
    const updateData = await updateRes.json();
    assert(updateData.name === 'Automated Tester Pro', `Updated name verified: ${updateData.name}`);

    // 4. Document Management & Private Streaming
    console.log('\n--- 4. Document Management & Private Streaming ---');
    // Upload a private document for this test user
    const dummyPdfContent = '%PDF-1.4\n1 0 obj\n<< /Title (TestDoc) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF';
    const blob = new Blob([dummyPdfContent], { type: 'application/pdf' });
    const formData = new FormData();
    formData.append('subject', 'Automated Verification Subject');
    formData.append('semester', '4');
    formData.append('type', 'Note');
    formData.append('file', blob, 'AutomatedTestDocument.pdf');

    const uploadRes = await fetch(`${BASE_URL}/docs/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${authToken}` },
      body: formData
    });
    assert(uploadRes.ok, `Document upload succeeded: ${uploadRes.status}`);
    const uploadData = await uploadRes.json();
    testDocId = uploadData._id;
    assert(!!testDocId, `Uploaded document ID received: ${testDocId}`);

    // Fetch user's documents
    const docsRes = await fetch(`${BASE_URL}/docs`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    assert(docsRes.ok, `User documents fetch succeeded`);
    const docsList = await docsRes.json();
    assert(Array.isArray(docsList) && docsList.length === 1 && docsList[0]._id === testDocId,
      `User sees only their own document in library (count: ${docsList.length})`);

    // Authenticated file streaming
    const streamRes = await fetch(`${BASE_URL}/docs/${testDocId}/file`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    assert(streamRes.ok, `Authenticated file streaming succeeded (status: ${streamRes.status})`);
    assert(streamRes.headers.get('content-type')?.includes('application/pdf'), `Stream Content-Type is application/pdf: ${streamRes.headers.get('content-type')}`);

    // Unauthenticated streaming rejected (401)
    const unauthStreamRes = await fetch(`${BASE_URL}/docs/${testDocId}/file`);
    assert(unauthStreamRes.status === 401, `Unauthenticated streaming properly rejected with 401 (got ${unauthStreamRes.status})`);

    // Insecure static /uploads route is disabled (404)
    const insecureStaticRes = await fetch(`http://localhost:5000/uploads/${uploadData.filename}`);
    assert(insecureStaticRes.status === 404, `Public static /uploads access is eliminated (got 404)`);

    // Notes Filter
    const notesRes = await fetch(`${BASE_URL}/notes?semester=4`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    assert(notesRes.ok, `Notes filter endpoint responded`);
    const notesList = await notesRes.json();
    assert(Array.isArray(notesList) && notesList.length === 1, `Notes filter returned user document (count: ${notesList.length})`);

    // Security Headers Check (Helmet)
    assert(!!streamRes.headers.get('x-dns-prefetch-control') || !!streamRes.headers.get('content-security-policy') || !!streamRes.headers.get('x-content-type-options'),
      `Helmet security headers confirmed present in HTTP responses`);

    // 5. Focus Meter & Study Session Stats
    console.log('\n--- 5. Focus Meter & Study Sessions ---');
    const sessionPayload = {
      documentId: testDocId,
      startTime: Date.now() - 60000,
      endTime: Date.now(),
      durationMs: 60000,
      focusedMs: 52000,
      distractedMs: 8000
    };
    const sessionRes = await fetch(`${BASE_URL}/study/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify(sessionPayload)
    });
    assert(sessionRes.ok, `Study session saved: ${sessionRes.status}`);

    const statsRes = await fetch(`${BASE_URL}/study/stats`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    assert(statsRes.ok, `User study stats retrieved`);
    const statsData = await statsRes.json();
    assert(statsData.totalSessions >= 1, `Total sessions counted: ${statsData.totalSessions}`);
    assert(statsData.focusPercentage > 80, `Focus percentage accurate: ${Math.round(statsData.focusPercentage)}%`);

    // 7. AI Live Interview Workflow
    console.log('\n--- 7. AI Live Interview Workflow ---');
    const genQuestionsRes = await fetch(`${BASE_URL}/study/generate-questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({
        documentId: testDocId,
        topic: 'Matrices & Linear Algebra',
        difficultyLevel: 'medium',
        questionCount: 3
      })
    });
    assert(genQuestionsRes.ok, `Live interview questions generated: ${genQuestionsRes.status}`);
    const questionsData = await genQuestionsRes.json();
    assert(Array.isArray(questionsData.questions) && questionsData.questions.length > 0, `Questions array received (count: ${questionsData.questions.length})`);
    console.log('Sample Generated Question:', questionsData.questions[0]);

    // Test follow-up question
    const followUpRes = await fetch(`${BASE_URL}/study/follow-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({
        documentId: testDocId,
        currentQuestion: questionsData.questions[0],
        studentAnswer: 'Matrices are arrays of numbers used for linear transformations and solving simultaneous linear equations.',
        topic: 'Matrices'
      })
    });
    assert(followUpRes.ok, `Follow-up endpoint responded: ${followUpRes.status}`);
    const followUpData = await followUpRes.json();
    assert(typeof followUpData.hasFollowUp === 'boolean', `Follow-up evaluation returned boolean: ${followUpData.hasFollowUp}`);
    if (followUpData.hasFollowUp) {
      console.log('AI Generated Follow-up Question:', followUpData.followUpQuestion);
    }

    // Evaluate Interview & Persist
    const evalPayload = {
      documentId: testDocId,
      studentAnswersArray: [
        {
          question: questionsData.questions[0],
          answer: 'A matrix represents linear transformations and data vectors in n-dimensional space.'
        }
      ],
      totalTime: 90000,
      focusedTime: 85000,
      distractedTime: 5000,
      difficultyLevel: 'medium',
      topic: 'Matrices'
    };

    const evalRes = await fetch(`${BASE_URL}/study/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify(evalPayload)
    });
    assert(evalRes.ok, `Interview evaluation generated: ${evalRes.status}`);
    const evalData = await evalRes.json();
    assert(!!evalData.attemptId, `Interview attempt persisted with ID: ${evalData.attemptId}`);
    assert(evalData.report && typeof evalData.report.average_score === 'number', `Report average score computed: ${evalData.report.average_score}`);
    assert(Array.isArray(evalData.evaluation), `Detailed evaluations returned (count: ${evalData.evaluation.length})`);

    // Verify persisted in interview history
    const historyRes = await fetch(`${BASE_URL}/study/interviews`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    assert(historyRes.ok, `Interview history retrieved: ${historyRes.status}`);
    const historyList = await historyRes.json();
    assert(historyList.some(h => h._id === evalData.attemptId), `Persisted interview attempt confirmed in user history`);

    // 8. Read & Test Quiz Workflow
    console.log('\n--- 8. Read & Test Quiz Workflow ---');
    const genQuizRes = await fetch(`${BASE_URL}/study/generate-quiz`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({
        documentId: testDocId,
        difficultyLevel: 'easy'
      })
    });
    assert(genQuizRes.ok, `Quiz generated: ${genQuizRes.status}`);
    const quizData = await genQuizRes.json();
    assert(Array.isArray(quizData.questions) && quizData.questions.length > 0, `Quiz questions received (count: ${quizData.questions.length})`);

    // Evaluate Quiz
    const evalQuizPayload = {
      documentId: testDocId,
      difficultyLevel: 'easy',
      questionsAndAnswers: quizData.questions.map(q => ({
        ...q,
        studentAnswer: q.options && q.options.length ? q.options[0] : 'Sample answer'
      }))
    };
    const evalQuizRes = await fetch(`${BASE_URL}/study/evaluate-quiz`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify(evalQuizPayload)
    });
    assert(evalQuizRes.ok, `Quiz evaluation completed and saved`);
    const evalQuizData = await evalQuizRes.json();
    assert(typeof evalQuizData.score === 'number', `Quiz score evaluated: ${evalQuizData.score}/${evalQuizData.totalQuestions}`);

    // 9. Document Deletion & Isolated Cleanup
    console.log('\n--- 9. Document Deletion & Isolated Cleanup ---');
    if (testDocId) {
      const delDocRes = await fetch(`${BASE_URL}/docs/${testDocId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      assert(delDocRes.ok, `Test document deleted: ${delDocRes.status}`);
    }

    // 10. Baseline User Data Preservation Verification
    console.log('\n--- 10. Baseline Data Preservation Verification ---');
    await mongoose.connect(process.env.MONGODB_URI);
    const User = require('./models/User');
    const Document = require('./models/Document');
    const StudySession = require('./models/StudySession');
    const QuizAttempt = require('./models/QuizAttempt');
    const InterviewAttempt = require('./models/InterviewAttempt');

    // Clean up test user and their test records
    if (testUserId) {
      await User.findByIdAndDelete(testUserId);
      await StudySession.deleteMany({ user: testUserId });
      await QuizAttempt.deleteMany({ user: testUserId });
      await InterviewAttempt.deleteMany({ user: testUserId });
      console.log(`[CLEANUP] Deleted isolated test user ID: ${testUserId}`);
    }

    // Verify primary user
    const primaryUser = await User.findOne({ email: '202401040072@mitaoe.ac.in' });
    assert(!!primaryUser, `Primary user account 202401040072@mitaoe.ac.in is intact`);
    const primaryDocs = await Document.find({ uploader: primaryUser._id });
    assert(primaryDocs.length === 8, `Primary user still owns all 8 documents (count: ${primaryDocs.length})`);
    await mongoose.connection.close();

    console.log('\n====================================================');
    console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log('====================================================');

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('Test execution error:', err);
    process.exit(1);
  }
}

runTests();
