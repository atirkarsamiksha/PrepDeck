require('dotenv').config();
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

const BASE_URL = 'http://localhost:5000/api';

async function testUploads() {
  console.log('==================================================');
  console.log('   TESTING NOTE & PYQ UPLOADS END-TO-END          ');
  console.log('==================================================');

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

  let authToken = '';
  let testUserId = '';
  const uploadedDocIds = [];
  const uploadedFiles = [];

  try {
    // 1. Create a test user
    const testEmail = `upload_tester_${Date.now()}@prepdeck.test`;
    const regRes = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Upload Tester', email: testEmail, password: 'Password123!' })
    });
    assert(regRes.ok, `Test user registered`);
    const regData = await regRes.json();
    authToken = regData.token;
    testUserId = regData._id;

    // 2. Note Upload (type: 'Note', examType omitted)
    console.log('\n--- 1. Note Upload Test ---');
    const dummyPdfContent = '%PDF-1.4\n1 0 obj\n<< /Title (TestNote) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF';
    const noteBlob = new Blob([dummyPdfContent], { type: 'application/pdf' });
    const noteFormData = new FormData();
    noteFormData.append('title', 'Distributed Systems Lecture 1');
    noteFormData.append('subject', 'Distributed Systems');
    noteFormData.append('semester', '6');
    noteFormData.append('type', 'Note');
    noteFormData.append('file', noteBlob, 'DS_Lecture_1.pdf');

    const noteRes = await fetch(`${BASE_URL}/docs/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${authToken}` },
      body: noteFormData
    });
    assert(noteRes.ok, `Note upload succeeded with status ${noteRes.status}`);
    const noteData = await noteRes.json();
    assert(noteData.type === 'Note', `Note type confirmed: ${noteData.type}`);
    assert(noteData.subject === 'Distributed Systems', `Subject confirmed: ${noteData.subject}`);
    assert(!!noteData._id, `Document ID returned: ${noteData._id}`);
    uploadedDocIds.push(noteData._id);
    uploadedFiles.push(noteData.filename);

    // Verify physical file exists on disk
    const uploadsDir = path.resolve(process.env.STORAGE_PATH || path.join(__dirname, 'uploads'));
    const noteFilePath = path.join(uploadsDir, noteData.filename);
    assert(fs.existsSync(noteFilePath), `Note physical file exists on disk: ${noteData.filename}`);

    // 3. PYQ Upload with valid examType and year
    console.log('\n--- 2. PYQ Upload Test (Valid examType) ---');
    const pyqBlob = new Blob([dummyPdfContent], { type: 'application/pdf' });
    const pyqFormData = new FormData();
    pyqFormData.append('title', 'Cloud Computing Endsem 2024');
    pyqFormData.append('subject', 'Cloud Computing');
    pyqFormData.append('semester', '6');
    pyqFormData.append('type', 'PYQ');
    pyqFormData.append('examType', 'endsem');
    pyqFormData.append('year', '2024');
    pyqFormData.append('file', pyqBlob, 'CC_Endsem_2024.pdf');

    const pyqRes = await fetch(`${BASE_URL}/docs/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${authToken}` },
      body: pyqFormData
    });
    assert(pyqRes.ok, `PYQ upload succeeded with status ${pyqRes.status}`);
    const pyqData = await pyqRes.json();
    assert(pyqData.type === 'PYQ', `PYQ type confirmed: ${pyqData.type}`);
    assert(pyqData.examType === 'endsem', `examType confirmed: ${pyqData.examType}`);
    assert(pyqData.year === '2024' || pyqData.year == 2024, `year confirmed: ${pyqData.year}`);
    uploadedDocIds.push(pyqData._id);
    uploadedFiles.push(pyqData.filename);

    const pyqFilePath = path.join(uploadsDir, pyqData.filename);
    assert(fs.existsSync(pyqFilePath), `PYQ physical file exists on disk: ${pyqData.filename}`);

    // 4. PYQ Upload with empty string examType (Regression check for enum bug)
    console.log('\n--- 3. PYQ Upload with Empty/Unspecified examType ---');
    const pyq2FormData = new FormData();
    pyq2FormData.append('title', 'Cloud Computing Midsem 2023');
    pyq2FormData.append('subject', 'Cloud Computing');
    pyq2FormData.append('semester', '6');
    pyq2FormData.append('type', 'PYQ');
    pyq2FormData.append('examType', ''); // Empty string should be sanitized, not cause Mongoose enum failure
    pyq2FormData.append('year', '2023');
    pyq2FormData.append('file', new Blob([dummyPdfContent], { type: 'application/pdf' }), 'CC_Midsem_2023.pdf');

    const pyq2Res = await fetch(`${BASE_URL}/docs/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${authToken}` },
      body: pyq2FormData
    });
    assert(pyq2Res.ok, `Upload with empty examType succeeds without crash (status ${pyq2Res.status})`);
    const pyq2Data = await pyq2Res.json();
    uploadedDocIds.push(pyq2Data._id);
    uploadedFiles.push(pyq2Data.filename);

    // 5. Invalid File Extension Check (reject .exe / non-pdf)
    console.log('\n--- 4. Invalid File Type Rejection ---');
    const badFileFormData = new FormData();
    badFileFormData.append('subject', 'Security');
    badFileFormData.append('semester', '6');
    badFileFormData.append('type', 'Note');
    badFileFormData.append('file', new Blob(['fake executable'], { type: 'application/octet-stream' }), 'malicious.exe');

    const badFileRes = await fetch(`${BASE_URL}/docs/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${authToken}` },
      body: badFileFormData
    });
    assert(badFileRes.status === 400, `Non-PDF upload rejected with 400 (got ${badFileRes.status})`);
    const badFileData = await badFileRes.json();
    assert(badFileData.message?.toLowerCase().includes('pdf'), `Error mentions PDF requirement: ${badFileData.message}`);

    // 6. Verify Filtered Lists
    console.log('\n--- 5. Filtered Lists Verification ---');
    const notesListRes = await fetch(`${BASE_URL}/notes`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const notesList = await notesListRes.json();
    assert(notesList.length === 1 && notesList[0]._id === noteData._id, `Notes list contains only Note: ${notesList.length}`);

    const pyqsListRes = await fetch(`${BASE_URL}/pyqs`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const pyqsList = await pyqsListRes.json();
    assert(pyqsList.length === 2, `PYQs list contains both PYQ uploads: ${pyqsList.length}`);

    // 7. Cleanup Test Documents and Verify Physical Deletion
    console.log('\n--- 6. Deletion and Zero-Orphan Cleanup ---');
    for (const id of uploadedDocIds) {
      const delRes = await fetch(`${BASE_URL}/docs/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      assert(delRes.ok, `Deleted document ${id}`);
    }

    // Verify all test files were physically removed from disk
    for (const fn of uploadedFiles) {
      const exists = fs.existsSync(path.join(uploadsDir, fn));
      assert(!exists, `Physical file cleanly deleted from disk: ${fn}`);
    }

    // Clean up test user
    await mongoose.connect(process.env.MONGODB_URI);
    const User = require('./models/User');
    await User.findByIdAndDelete(testUserId);
    await mongoose.connection.close();
    console.log(`[CLEANUP] Deleted test user: ${testUserId}`);

    console.log('\n==================================================');
    console.log(`UPLOAD SUITE RESULTS: ${passed} Passed, ${failed} Failed`);
    console.log('==================================================');
    process.exit(failed > 0 ? 1 : 0);

  } catch (err) {
    console.error('Upload test error:', err);
    process.exit(1);
  }
}

testUploads();
