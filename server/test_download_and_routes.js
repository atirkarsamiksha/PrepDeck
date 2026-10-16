require('dotenv').config();
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

const BASE_URL = 'http://localhost:5000/api';
const HOST_URL = 'http://localhost:5000';

async function testDownloadAndRoutes() {
  console.log('==================================================');
  console.log('   TESTING DOWNLOADS, ROUTES & ISOLATION          ');
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

  let userAToken = '';
  let userBToken = '';
  let userAId = '';
  let userBId = '';
  let testDocId = '';
  let testFilename = '';

  try {
    // 1. Static file check for interview.html
    console.log('\n--- 1. Static Route Checks ---');
    const interviewPageRes = await fetch(`${HOST_URL}/interview.html`);
    assert(interviewPageRes.ok, `interview.html is accessible (status: ${interviewPageRes.status})`);
    const pageHtml = await interviewPageRes.text();
    assert(pageHtml.includes('FocusDetector') && pageHtml.includes('AI Live Viva Interview'),
      `interview.html contains FocusDetector and Viva header`);

    const focusDetectorJsRes = await fetch(`${HOST_URL}/js/focus-detector.js`);
    assert(focusDetectorJsRes.ok, `js/focus-detector.js is accessible (status: ${focusDetectorJsRes.status})`);

    // 2. Register User A & User B
    console.log('\n--- 2. Setting Up Test Accounts ---');
    const userAEmail = `download_tester_a_${Date.now()}@prepdeck.test`;
    const regARes = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'User A', email: userAEmail, password: 'Password123!' })
    });
    const regAData = await regARes.json();
    userAToken = regAData.token;
    userAId = regAData._id;

    const userBEmail = `download_tester_b_${Date.now()}@prepdeck.test`;
    const regBRes = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'User B', email: userBEmail, password: 'Password123!' })
    });
    const regBData = await regBRes.json();
    userBToken = regBData.token;
    userBId = regBData._id;

    assert(!!userAToken && !!userBToken, `Both test users registered`);

    // 3. User A uploads a document
    console.log('\n--- 3. Uploading Test PDF for User A ---');
    const dummyPdfContent = '%PDF-1.4\n1 0 obj\n<< /Title (DownloadTestDoc) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF';
    const blob = new Blob([dummyPdfContent], { type: 'application/pdf' });
    const formData = new FormData();
    formData.append('subject', 'Advanced Operating Systems');
    formData.append('semester', '5');
    formData.append('type', 'Note');
    formData.append('file', blob, 'OS_Kernel_Architecture.pdf');

    const uploadRes = await fetch(`${BASE_URL}/docs/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${userAToken}` },
      body: formData
    });
    assert(uploadRes.ok, `Upload succeeded`);
    const docData = await uploadRes.json();
    testDocId = docData._id;
    testFilename = docData.filename;

    // 4. Test In-Browser Streaming (inline)
    console.log('\n--- 4. In-Browser Streaming (Inline) ---');
    const streamRes = await fetch(`${BASE_URL}/docs/${testDocId}/file`, {
      headers: { 'Authorization': `Bearer ${userAToken}` }
    });
    assert(streamRes.ok, `Stream request returned status 200`);
    assert(streamRes.headers.get('content-type')?.includes('application/pdf'), `Content-Type is application/pdf`);
    const inlineDisposition = streamRes.headers.get('content-disposition');
    assert(inlineDisposition && inlineDisposition.startsWith('inline'),
      `Content-Disposition is inline for reader: "${inlineDisposition}"`);

    // 5. Test Direct File Download (attachment)
    console.log('\n--- 5. Direct File Download (Attachment) ---');
    const downloadRes = await fetch(`${BASE_URL}/docs/${testDocId}/file?download=true`, {
      headers: { 'Authorization': `Bearer ${userAToken}` }
    });
    assert(downloadRes.ok, `Download request returned status 200`);
    const attachDisposition = downloadRes.headers.get('content-disposition');
    assert(attachDisposition && attachDisposition.includes('attachment'),
      `Content-Disposition is attachment for download: "${attachDisposition}"`);
    assert(attachDisposition.includes('OS_Kernel_Architecture.pdf'),
      `Original filename preserved in disposition: "${attachDisposition}"`);
    const downloadedBlob = await downloadRes.blob();
    assert(downloadedBlob.size > 0, `Downloaded blob has valid non-zero size (${downloadedBlob.size} bytes)`);

    // 6. Test Unauthenticated Download Protection
    console.log('\n--- 6. Unauthenticated Protection ---');
    const unauthRes = await fetch(`${BASE_URL}/docs/${testDocId}/file?download=true`);
    assert(unauthRes.status === 401, `Unauthenticated download properly rejected with 401 (got ${unauthRes.status})`);

    // 7. Test Cross-User Isolation (User B cannot download User A's file)
    console.log('\n--- 7. Multi-Tenant Authorization Isolation ---');
    const crossUserRes = await fetch(`${BASE_URL}/docs/${testDocId}/file?download=true`, {
      headers: { 'Authorization': `Bearer ${userBToken}` }
    });
    assert(crossUserRes.status === 404, `User B download on User A doc rejected with 404 (got ${crossUserRes.status})`);

    // 8. Clean Cleanup
    console.log('\n--- 8. Cleanup Isolated Test Data ---');
    const delRes = await fetch(`${BASE_URL}/docs/${testDocId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${userAToken}` }
    });
    assert(delRes.ok, `Document deleted`);

    const uploadsDir = path.resolve(process.env.STORAGE_PATH || path.join(__dirname, 'uploads'));
    const exists = fs.existsSync(path.join(uploadsDir, testFilename));
    assert(!exists, `Physical file removed from disk: ${testFilename}`);

    await mongoose.connect(process.env.MONGODB_URI);
    const User = require('./models/User');
    await User.findByIdAndDelete(userAId);
    await User.findByIdAndDelete(userBId);
    await mongoose.connection.close();
    console.log(`[CLEANUP] Cleaned up test users`);

    console.log('\n==================================================');
    console.log(`DOWNLOAD & ROUTE RESULTS: ${passed} Passed, ${failed} Failed`);
    console.log('==================================================');
    process.exit(failed > 0 ? 1 : 0);

  } catch(err) {
    console.error("Test error:", err);
    process.exit(1);
  }
}

testDownloadAndRoutes();
