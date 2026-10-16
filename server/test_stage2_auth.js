require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');

const BASE_URL = 'http://localhost:5000/api';

async function runStage2Tests() {
  console.log('==================================================');
  console.log('   STAGE 2: AUTHENTICATION & NORMALIZATION TESTS   ');
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

  const testEmailRaw = `  Stage2_Tester_${Date.now()}@PrepDeck.Test  `;
  const normalizedExpected = testEmailRaw.trim().toLowerCase();
  const testPassword = 'Password123!';
  let createdUserId = null;

  try {
    // 1. Verify existing users were untouched
    console.log('\n--- 1. Baseline User Integrity Check ---');
    const samiksha = await User.findOne({ email: '202401040072@mitaoe.ac.in' });
    assert(!!samiksha, `Primary user 202401040072@mitaoe.ac.in exists and intact`);

    // 2. Test Registration with unnormalized email (spaces & uppercase)
    console.log('\n--- 2. Registration with Email Normalization ---');
    const { registerUser, loginUser } = require('./controllers/authController');

    // Test controller directly or via mock req/res to verify logic
    let resStatus = null;
    let resData = null;
    const mockRes = () => ({
      status(code) { resStatus = code; return this; },
      json(data) { resData = data; return this; }
    });

    await registerUser({
      body: { name: '  Stage Two Tester  ', email: testEmailRaw, password: testPassword }
    }, mockRes());

    assert(resStatus === 201, `Registration returned status 201 (got ${resStatus})`);
    assert(resData && resData.email === normalizedExpected, `Email normalized to lowercase and trimmed: ${resData?.email}`);
    assert(!!resData?.token, `Valid JWT token generated upon registration`);
    createdUserId = resData?._id;

    // 3. Test Repeated Login with different case / spaces
    console.log('\n--- 3. Repeated Login Verification ---');
    resStatus = null;
    resData = null;
    await loginUser({
      body: { email: testEmailRaw.toUpperCase(), password: testPassword }
    }, mockRes());
    assert(resStatus !== 401 && resStatus !== 400, `First login succeeded (status ${resStatus || 200})`);
    assert(!!resData?.token, `First login returned valid token`);

    // Second login attempt (repeat login)
    resStatus = null;
    resData = null;
    await loginUser({
      body: { email: normalizedExpected, password: testPassword }
    }, mockRes());
    assert(resStatus !== 401 && resStatus !== 400, `Second repeated login succeeded without 'user already exists' error`);
    assert(!!resData?.token, `Second repeated login returned valid token`);

    // 4. Duplicate Registration Rejection
    console.log('\n--- 4. Duplicate Registration Rejection ---');
    resStatus = null;
    resData = null;
    await registerUser({
      body: { name: 'Another Name', email: testEmailRaw, password: 'DifferentPassword123' }
    }, mockRes());
    assert(resStatus === 400, `Duplicate registration rejected with status 400 (got ${resStatus})`);
    assert(resData?.message?.includes('already exists'), `Message indicates user already exists: "${resData?.message}"`);

    // 5. Invalid Password Rejection
    console.log('\n--- 5. Invalid Password Rejection ---');
    resStatus = null;
    resData = null;
    await loginUser({
      body: { email: normalizedExpected, password: 'WrongPassword999!' }
    }, mockRes());
    assert(resStatus === 401, `Invalid password rejected with status 401 (got ${resStatus})`);
    assert(resData?.message === 'Invalid email or password', `Generic security error message returned: "${resData?.message}"`);

    // 6. Validation Checks
    console.log('\n--- 6. Input Validation Checks ---');
    resStatus = null;
    resData = null;
    await registerUser({
      body: { name: '', email: normalizedExpected, password: testPassword }
    }, mockRes());
    assert(resStatus === 400, `Empty name rejected with 400`);

    resStatus = null;
    resData = null;
    await registerUser({
      body: { name: 'Valid Name', email: 'invalid-email-string', password: testPassword }
    }, mockRes());
    assert(resStatus === 400, `Malformed email rejected with 400`);

    resStatus = null;
    resData = null;
    await registerUser({
      body: { name: 'Valid Name', email: 'valid@prepdeck.test', password: '123' }
    }, mockRes());
    assert(resStatus === 400, `Password shorter than 6 chars rejected with 400`);

  } finally {
    // Isolated Cleanup: Clean up ONLY the temporary test user
    if (createdUserId) {
      await User.findByIdAndDelete(createdUserId);
      console.log(`\n[CLEANUP] Deleted isolated test user ID: ${createdUserId}`);
    }
    await mongoose.connection.close();
  }

  console.log('\n==================================================');
  console.log(`STAGE 2 RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log('==================================================');

  if (failed > 0) process.exit(1);
}

runStage2Tests().catch(err => {
  console.error('Stage 2 Test Error:', err);
  process.exit(1);
});
