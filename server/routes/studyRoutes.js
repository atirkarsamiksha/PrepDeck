const express = require('express');
const router = express.Router();
const { 
  saveSessionStats, 
  getUserStats, 
  generateInterviewQuestions, 
  generateFollowUpQuestion,
  evaluateInterviewSession, 
  getInterviewHistory,
  generateQuiz, 
  evaluateQuiz, 
  getQuizHistory, 
  getStudySessionsHistory, 
  getAllQuizHistory 
} = require('../controllers/studyController');
const { protect } = require('../middleware/authMiddleware');

router.post('/session', protect, saveSessionStats);
router.get('/stats', protect, getUserStats);
router.get('/sessions', protect, getStudySessionsHistory);
router.get('/quizzes', protect, getAllQuizHistory);
router.get('/interviews', protect, getInterviewHistory);

// AI Interview Routes
router.post('/generate-questions', protect, generateInterviewQuestions);
router.post('/follow-up', protect, generateFollowUpQuestion);
router.post('/evaluate', protect, evaluateInterviewSession);

// Read & Test Routes
router.post('/generate-quiz', protect, generateQuiz);
router.post('/evaluate-quiz', protect, evaluateQuiz);
router.get('/quiz-history/:documentId', protect, getQuizHistory);

module.exports = router;
