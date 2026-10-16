const mongoose = require('mongoose');

const interviewAttemptSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  document: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Document'
  },
  topic: {
    type: String,
    default: 'General'
  },
  difficultyLevel: {
    type: String,
    enum: ['easy', 'medium', 'hard'],
    default: 'medium'
  },
  score: {
    type: Number,
    required: true
  },
  totalQuestions: {
    type: Number,
    required: true
  },
  disciplineLevel: {
    type: String,
    default: 'Moderately Focused'
  },
  focusPercentage: {
    type: Number,
    default: 100
  },
  questions: [{
    question: String,
    studentAnswer: String,
    expectedAnswer: String,
    score: Number,
    correctness: String,
    feedback: String
  }],
  report: {
    average_score: Number,
    focus_percentage: Number,
    discipline_level: String,
    summary: String,
    strengths: [String],
    weaknesses: [String],
    behavior_analysis: String,
    suggestions: [String]
  },
  sessionStats: {
    totalTimeMs: Number,
    focusedTimeMs: Number,
    distractedTimeMs: Number,
    distractionEvents: Number
  },
  attemptedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('InterviewAttempt', interviewAttemptSchema);
