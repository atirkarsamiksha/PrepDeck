require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const User = require('./models/User');
const Document = require('./models/Document');
const { 
  getDocuments, 
  getFilteredNotes, 
  getFilteredPyqs, 
  getDocumentById, 
  deleteDocument, 
  streamDocumentFile 
} = require('./controllers/docController');
const { generateQuiz, generateInterviewQuestions } = require('./controllers/studyController');

async function runStage3Tests() {
  console.log('==================================================');
  console.log('   STAGE 3: MULTI-TENANT ISOLATION & STREAMING    ');
  console.log('==================================================');

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

  let userA = null;
  let userB = null;
  let testDoc = null;
  let dummyPdfPath = null;

  try {
    // 1. Verify baseline user and 8 PDFs are untouched
    console.log('\n--- 1. Baseline Primary User Verification ---');
    const samiksha = await User.findOne({ email: '202401040072@mitaoe.ac.in' });
    assert(!!samiksha, `Primary user 202401040072@mitaoe.ac.in exists`);
    const baselineDocs = await Document.find({ uploader: samiksha._id });
    assert(baselineDocs.length === 8, `Primary user still owns exactly 8 documents (found: ${baselineDocs.length})`);

    // 2. Create isolated test users A and B
    console.log('\n--- 2. Setting Up Isolated Users A and B ---');
    userA = await User.create({
      name: 'Isolated User A',
      email: `test_user_a_${Date.now()}@prepdeck.test`,
      password: 'Password123!'
    });
    userB = await User.create({
      name: 'Isolated User B',
      email: `test_user_b_${Date.now()}@prepdeck.test`,
      password: 'Password123!'
    });
    assert(!!userA._id && !!userB._id, `Isolated test users A and B created successfully`);

    // 3. Create a dummy physical PDF for User A
    const uploadsDir = path.resolve(process.env.STORAGE_PATH || path.join(__dirname, 'uploads'));
    const testPdfFilename = `test_file_${Date.now()}.pdf`;
    dummyPdfPath = path.resolve(uploadsDir, testPdfFilename);
    fs.writeFileSync(dummyPdfPath, '%PDF-1.4 Isolated Test PDF Content %%EOF');

    testDoc = await Document.create({
      filename: testPdfFilename,
      originalName: 'Isolation_Test_Note.pdf',
      subject: 'Isolation Subject',
      semester: '3',
      type: 'Note',
      uploader: userA._id,
      filepath: `/uploads/${testPdfFilename}`
    });
    assert(!!testDoc._id, `User A test document created with ID: ${testDoc._id}`);

    // Helper for mock Express req/res
    const makeMockRes = () => {
      let statusCode = 200;
      let body = null;
      let headers = {};
      let pipedStream = null;
      return {
        status(c) { statusCode = c; return this; },
        json(b) { body = b; return this; },
        setHeader(k, v) { headers[k] = v; return this; },
        writeHead(c, h) { statusCode = c; Object.assign(headers, h); return this; },
        pipe(dest) { pipedStream = dest; return this; },
        write(chunk) { return true; },
        on(event, cb) { return this; },
        once(event, cb) { return this; },
        emit() { return true; },
        end(data) { body = data; return this; },
        getStatus: () => statusCode,
        getBody: () => body,
        getHeaders: () => headers,
        headersSent: false
      };
    };

    // 4. Test User A queries documents -> Sees their 1 document
    console.log('\n--- 3. Document Scoping & Visibility ---');
    let res = makeMockRes();
    await getDocuments({ user: userA, query: {} }, res);
    let listA = res.getBody();
    assert(Array.isArray(listA) && listA.length === 1 && listA[0]._id.equals(testDoc._id),
      `User A sees exactly their 1 document in getDocuments (count: ${listA?.length})`);

    // 5. Test User B queries documents -> Sees 0 documents (strict isolation)
    res = makeMockRes();
    await getDocuments({ user: userB, query: {} }, res);
    let listB = res.getBody();
    assert(Array.isArray(listB) && listB.length === 0,
      `User B cannot see User A's document in getDocuments (count: ${listB?.length})`);

    // 6. Test User B queries filtered notes & pyqs -> Sees 0
    res = makeMockRes();
    await getFilteredNotes({ user: userB, query: {} }, res);
    assert(res.getBody()?.length === 0, `User B sees 0 notes in getFilteredNotes`);

    res = makeMockRes();
    await getFilteredPyqs({ user: userB, query: {} }, res);
    assert(res.getBody()?.length === 0, `User B sees 0 PYQs in getFilteredPyqs`);

    // 7. BOLA Check: User B attempts getDocumentById on User A's document -> 404
    console.log('\n--- 4. BOLA & Ownership Checks ---');
    res = makeMockRes();
    await getDocumentById({ user: userB, params: { id: testDoc._id.toString() } }, res);
    assert(res.getStatus() === 404, `User B accessing User A document by ID returns 404 (status: ${res.getStatus()})`);

    // 8. User B attempts to delete User A's document -> 404
    res = makeMockRes();
    await deleteDocument({ user: userB, params: { id: testDoc._id.toString() } }, res);
    assert(res.getStatus() === 404, `User B attempting delete on User A document returns 404 (status: ${res.getStatus()})`);

    // 9. User B attempts to stream User A's document file -> 404
    res = makeMockRes();
    await streamDocumentFile({ user: userB, params: { id: testDoc._id.toString() } }, res);
    assert(res.getStatus() === 404, `User B streaming User A document file returns 404 (status: ${res.getStatus()})`);

    // 10. User B attempts generateQuiz on User A's document -> 404
    res = makeMockRes();
    await generateQuiz({ user: userB, body: { documentId: testDoc._id.toString() } }, res);
    assert(res.getStatus() === 404, `User B generateQuiz on User A document returns 404 (status: ${res.getStatus()})`);

    // 11. User B attempts generateInterviewQuestions on User A's document -> 404
    res = makeMockRes();
    await generateInterviewQuestions({ user: userB, body: { documentId: testDoc._id.toString() } }, res);
    assert(res.getStatus() === 404, `User B generateInterview on User A document returns 404 (status: ${res.getStatus()})`);

    // 12. Path Traversal Guard Check
    console.log('\n--- 5. Path Traversal Protection ---');
    // Temporarily point doc.filename to a traversal path
    const fakeTraversalDoc = await Document.create({
      filename: '../../server.js',
      originalName: 'hack.pdf',
      subject: 'Traversal',
      semester: '1',
      type: 'Note',
      uploader: userA._id,
      filepath: '/uploads/../../server.js'
    });
    res = makeMockRes();
    await streamDocumentFile({ user: userA, params: { id: fakeTraversalDoc._id.toString() } }, res);
    // path.basename prevents traversal, but if it reaches path check it yields 403 or 404
    assert(res.getStatus() === 403 || res.getStatus() === 404, `Path traversal attack blocked with status ${res.getStatus()}`);
    await Document.findByIdAndDelete(fakeTraversalDoc._id);

    // 13. User A authorized file streaming test
    console.log('\n--- 6. Authorized File Streaming ---');
    res = makeMockRes();
    await streamDocumentFile({ user: userA, params: { id: testDoc._id.toString() } }, res);
    assert(res.getHeaders()['Content-Type'] === 'application/pdf', `Content-Type application/pdf set correctly`);
    assert(res.getHeaders()['Content-Disposition']?.includes('Isolation_Test_Note.pdf'), `Content-Disposition header includes correct filename`);

  } finally {
    // Isolated Cleanup: Delete ONLY the test document, test file, and test users
    console.log('\n--- 7. Cleanup Test Artifacts ---');
    await new Promise(r => setTimeout(r, 100));
    if (testDoc?._id) {
      await Document.findByIdAndDelete(testDoc._id);
      console.log(`[CLEANUP] Deleted isolated test document: ${testDoc._id}`);
    }
    if (dummyPdfPath && fs.existsSync(dummyPdfPath)) {
      try {
        fs.unlinkSync(dummyPdfPath);
        console.log(`[CLEANUP] Deleted dummy test file on disk: ${dummyPdfPath}`);
      } catch (e) {}
    }
    if (userA?._id) {
      await User.findByIdAndDelete(userA._id);
      console.log(`[CLEANUP] Deleted isolated user A: ${userA._id}`);
    }
    if (userB?._id) {
      await User.findByIdAndDelete(userB._id);
      console.log(`[CLEANUP] Deleted isolated user B: ${userB._id}`);
    }
    await mongoose.connection.close();
  }

  console.log('\n==================================================');
  console.log(`STAGE 3 RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log('==================================================');

  if (failed > 0) process.exit(1);
}

runStage3Tests().catch(err => {
  console.error('Stage 3 Test Error:', err);
  process.exit(1);
});
