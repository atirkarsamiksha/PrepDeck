require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const User = require('./models/User');
const Document = require('./models/Document');

async function testLaunchReadiness() {
  console.log('====================================================');
  console.log('   LAUNCH READINESS & CRITICAL BUG VERIFICATION     ');
  console.log('====================================================');

  await mongoose.connect(process.env.MONGODB_URI);

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

  const BASE_URL = 'http://localhost:5000';

  try {
    // 1. Verify Primary Baseline User & Documents
    console.log('\n--- 1. Baseline Primary User Integrity ---');
    const primaryUser = await User.findOne({ email: '202401040072@mitaoe.ac.in' });
    assert(!!primaryUser, 'Baseline primary user 202401040072@mitaoe.ac.in exists');
    const userDocs = await Document.find({ uploader: primaryUser._id });
    assert(userDocs.length === 8, `Baseline primary user owns all 8 documents (found: ${userDocs.length})`);

    const primaryToken = jwt.sign({ id: primaryUser._id.toString() }, process.env.JWT_SECRET, { expiresIn: '30d' });

    // 2. Test Cache-Control Headers on HTML Pages (Prevents browser bfcache exposing private pages after logout)
    console.log('\n--- 2. Cache-Control Security on HTML Pages ---');
    const htmlPages = ['/dashboard.html', '/notes.html', '/pyqs.html', '/read_test.html', '/study.html', '/interview.html', '/upload.html', '/reports.html'];
    for (const page of htmlPages) {
      const res = await fetch(`${BASE_URL}${page}`);
      const cc = res.headers.get('cache-control') || '';
      assert(cc.includes('no-store') && cc.includes('no-cache'), `Page ${page} sends Cache-Control: no-store, no-cache (got: "${cc}")`);
    }

    // 3. Test Real PDF Download via Header Auth and Query Token Auth
    console.log('\n--- 3. Real PDF Download Flow ---');
    const practicalDoc = userDocs.find(d => d.originalName === 'Practical1.pdf');
    assert(!!practicalDoc, `Found Practical1.pdf in user documents (ID: ${practicalDoc._id})`);

    // 3a. Header Authorization
    const dlHeaderRes = await fetch(`${BASE_URL}/api/docs/${practicalDoc._id}/file?download=true`, {
      headers: { Authorization: `Bearer ${primaryToken}` }
    });
    assert(dlHeaderRes.status === 200, `Download via Authorization header returned status 200`);
    assert(dlHeaderRes.headers.get('content-type') === 'application/pdf', `Content-Type is application/pdf`);
    const dispHeader = dlHeaderRes.headers.get('content-disposition') || '';
    assert(dispHeader.includes('attachment') && dispHeader.includes('Practical1.pdf'), `Content-Disposition is attachment with original filename (got: "${dispHeader}")`);
    const headerBuf = await dlHeaderRes.arrayBuffer();
    assert(headerBuf.byteLength === 85202, `Downloaded file size matches actual physical file on disk (85,202 bytes, got: ${headerBuf.byteLength})`);
    const headerMagic = Buffer.from(headerBuf.slice(0, 5)).toString('utf8');
    assert(headerMagic === '%PDF-', `Downloaded file starts with valid PDF magic bytes ("%PDF-")`);

    // 3b. Query Parameter Token (for native browser click / direct links)
    const dlQueryRes = await fetch(`${BASE_URL}/api/docs/${practicalDoc._id}/file?download=true&token=${encodeURIComponent(primaryToken)}`);
    assert(dlQueryRes.status === 200, `Download via query token returned status 200`);
    const queryBuf = await dlQueryRes.arrayBuffer();
    assert(queryBuf.byteLength === 85202, `Query token download delivered complete 85,202 bytes`);

    // 4. Test Second File Type (TXT document upload, view, and download)
    console.log('\n--- 4. Secondary File Type (TXT) Upload, View & Download ---');
    const txtContent = 'PrepDeck Test Study Guide for Discrete Mathematics.\nKey Concepts:\n1. Graphs and Trees\n2. Propositional Logic\n3. Proofs by Induction.';
    const boundary = '----PrepDeckMultipartBoundary' + Date.now();
    let body = `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="subject"\r\n\r\nDiscrete Mathematics\r\n`;
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="semester"\r\n\r\n3\r\n`;
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="type"\r\n\r\nNote\r\n`;
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="file"; filename="Discrete_Math_Notes.txt"\r\n`;
    body += `Content-Type: text/plain\r\n\r\n`;
    body += txtContent + `\r\n`;
    body += `--${boundary}--\r\n`;

    const uploadTxtRes = await fetch(`${BASE_URL}/api/docs/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${primaryToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: Buffer.from(body)
    });
    assert(uploadTxtRes.status === 201, `TXT document upload succeeded with status 201 (got: ${uploadTxtRes.status})`);
    const txtDoc = await uploadTxtRes.json();
    assert(txtDoc.originalName === 'Discrete_Math_Notes.txt', `TXT document original name preserved: ${txtDoc.originalName}`);

    // Stream TXT
    const streamTxtRes = await fetch(`${BASE_URL}/api/docs/${txtDoc._id}/file`, {
      headers: { Authorization: `Bearer ${primaryToken}` }
    });
    assert(streamTxtRes.status === 200, `Streaming TXT returned 200`);
    assert(streamTxtRes.headers.get('content-type').includes('text/plain'), `TXT Content-Type is text/plain (got: ${streamTxtRes.headers.get('content-type')})`);
    const streamTxtBody = await streamTxtRes.text();
    assert(streamTxtBody.includes('Graphs and Trees'), `TXT content streamed correctly`);

    // Download TXT
    const dlTxtRes = await fetch(`${BASE_URL}/api/docs/${txtDoc._id}/file?download=true&token=${encodeURIComponent(primaryToken)}`);
    assert(dlTxtRes.status === 200, `TXT download returned 200`);
    const dlTxtDisp = dlTxtRes.headers.get('content-disposition') || '';
    assert(dlTxtDisp.includes('attachment') && dlTxtDisp.includes('Discrete_Math_Notes.txt'), `TXT Content-Disposition is attachment with correct filename (got: "${dlTxtDisp}")`);
    const dlTxtText = await dlTxtRes.text();
    assert(dlTxtText === txtContent, `Downloaded TXT content byte-for-byte matches uploaded text`);

    // Clean up TXT doc so baseline remains clean
    await Document.findByIdAndDelete(txtDoc._id);
    const uploadsDir = path.resolve(process.env.STORAGE_PATH || path.join(__dirname, 'uploads'));
    const txtPath = path.resolve(uploadsDir, txtDoc.filename);
    if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath);
    console.log(`[CLEANUP] Deleted temporary TXT test document: ${txtDoc._id}`);

    // 5. Test Logout Flow
    console.log('\n--- 5. Logout & Session Invalidation Flow ---');
    const logoutRes = await fetch(`${BASE_URL}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${primaryToken}` }
    });
    assert(logoutRes.status === 200, `POST /api/auth/logout responded with 200`);
    const logoutData = await logoutRes.json();
    assert(logoutData.message === 'Logged out successfully', `Logout message confirmed: "${logoutData.message}"`);

    // Verify unauthenticated access without token is rejected
    const unauthRes = await fetch(`${BASE_URL}/api/docs`, {
      headers: {}
    });
    assert(unauthRes.status === 401, `Access to protected /api/docs without token returns 401`);

    const unauthDlRes = await fetch(`${BASE_URL}/api/docs/${practicalDoc._id}/file?download=true`);
    assert(unauthDlRes.status === 401, `Direct download without token returns 401 Unauthorized`);

    // 6. Test Multi-Tenant Boundary Checks
    console.log('\n--- 6. Multi-Tenant Authorization Protection ---');
    const dummyUser = await User.create({
      name: 'Unauthorized Stranger',
      email: `stranger_${Date.now()}@prepdeck.test`,
      password: 'Password123!'
    });
    const strangerToken = jwt.sign({ id: dummyUser._id.toString() }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const strangerDlRes = await fetch(`${BASE_URL}/api/docs/${practicalDoc._id}/file?download=true`, {
      headers: { Authorization: `Bearer ${strangerToken}` }
    });
    assert(strangerDlRes.status === 404, `Stranger attempting to download primary user doc is rejected with 404 (got: ${strangerDlRes.status})`);

    await User.findByIdAndDelete(dummyUser._id);
    console.log(`[CLEANUP] Deleted stranger test account`);

    // 7. Verify All 8 Baseline PDFs Remain Pure and Accessible
    console.log('\n--- 7. Final Baseline Integrity Check ---');
    const finalDocs = await Document.find({ uploader: primaryUser._id });
    assert(finalDocs.length === 8, `Primary user still owns exactly 8 documents`);

    console.log('\n====================================================');
    console.log(`RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('====================================================\n');

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('Test execution error:', err);
    process.exit(1);
  }
}

testLaunchReadiness();
