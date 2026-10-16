// Ensure DOMMatrix polyfill is defined for PDF parsing in Node 22+
if (typeof DOMMatrix === 'undefined') {
  global.DOMMatrix = class DOMMatrix {};
}

const StudySession = require('../models/StudySession');
const Document = require('../models/Document');
const QuizAttempt = require('../models/QuizAttempt');
const InterviewAttempt = require('../models/InterviewAttempt');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { PDFParse } = require('pdf-parse');
const fs = require('fs');
const path = require('path');

function extractJsonFromText(raw) {
  if (!raw) return null;
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const firstBrace = cleaned.search(/[{\[]/);
    const lastBrace = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const sub = cleaned.substring(firstBrace, lastBrace + 1);
      return JSON.parse(sub);
    }
    throw e;
  }
}

async function extractPdfText(doc) {
  if (!doc || !doc.filepath) return '';
  const absolutePath = path.join(__dirname, '..', doc.filepath);
  if (!fs.existsSync(absolutePath)) return '';

  try {
    const dataBuffer = fs.readFileSync(absolutePath);
    const parser = new PDFParse({ data: dataBuffer });
    const pdfData = await parser.getText();
    await parser.destroy();
    return (pdfData.text || '').substring(0, 15000);
  } catch (err) {
    console.warn("Could not parse PDF text:", err.message);
    return '';
  }
}

const saveSessionStats = async (req, res) => {
  try {
    const { documentId, startTime, endTime, durationMs, focusedMs, distractedMs } = req.body;

    const session = await StudySession.create({
      user: req.user._id,
      document: documentId || null,
      startTime: startTime || Date.now(),
      endTime: endTime || Date.now(),
      durationMs: durationMs || 0,
      focusedMs: focusedMs || 0,
      distractedMs: distractedMs || 0
    });

    res.status(201).json(session);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getUserStats = async (req, res) => {
  try {
    const sessions = await StudySession.find({ user: req.user._id });

    let totalStudyTime = 0;
    let totalFocusedTime = 0;

    sessions.forEach(s => {
      totalStudyTime += s.durationMs || 0;
      totalFocusedTime += s.focusedMs || 0;
    });

    res.json({
      totalSessions: sessions.length,
      totalStudyTime,
      totalFocusedTime,
      focusPercentage: totalStudyTime > 0 ? (totalFocusedTime / totalStudyTime) * 100 : 0
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const CANDIDATE_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-flash-latest",
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite"
];

async function generateWithGemini(prompt) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured in server environment.');
  }
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  let lastError = null;

  for (const modelName of CANDIDATE_MODELS) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      return (await result.response).text();
    } catch (err) {
      lastError = err;
      console.warn(`Gemini model ${modelName} failed (${err.message}). Trying fallback...`);
    }
  }
  throw lastError || new Error('All Gemini candidate models failed.');
}

const generateInterviewQuestions = async (req, res) => {
  try {
    const { documentId, topic, difficultyLevel = 'medium', questionCount = 5 } = req.body;

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ 
        message: 'GEMINI_API_KEY is not configured in server environment.' 
      });
    }

    let pdfText = '';
    let subjectName = topic || 'General Academic Topic';

    if (documentId) {
      const doc = await Document.findOne({ _id: documentId, uploader: req.user._id });
      if (!doc) {
        return res.status(404).json({ message: 'Document not found or access denied' });
      }
      subjectName = doc.subject;
      pdfText = await extractPdfText(doc);
    }

    const count = Math.min(Math.max(parseInt(questionCount) || 5, 2), 10);
    const difficulty = ['easy', 'medium', 'hard'].includes(difficultyLevel) ? difficultyLevel : 'medium';

    const prompt = `You are a university professor conducting an interactive technical viva / interview.
Subject: ${subjectName}
Specific Topic Focus: ${topic || 'All core concepts from the material'}
Difficulty Level: ${difficulty}
Generate exactly ${count} distinct interview questions to test the student.
The questions should test comprehension, concept explanation, and practical application.
Return strictly a valid JSON array of strings containing the questions only. No markdown formatting, no explanations.
Study Material Excerpt:
${pdfText || 'Assess standard syllabus concepts for ' + subjectName}`;

    const textOut = await generateWithGemini(prompt);
    const questions = extractJsonFromText(textOut);

    if (!Array.isArray(questions)) {
      throw new Error("Invalid question format received from AI model.");
    }

    res.json({ questions, topic: subjectName, difficultyLevel: difficulty });
  } catch (error) {
    console.error('generateInterviewQuestions error:', error);
    res.status(500).json({ message: error.message || 'Failed to generate interview questions' });
  }
};

const generateFollowUpQuestion = async (req, res) => {
  try {
    const { documentId, currentQuestion, studentAnswer, topic } = req.body;

    if (!currentQuestion || !studentAnswer) {
      return res.status(400).json({ message: 'Current question and student answer required.' });
    }

    // If answer is empty or just "[No Answer Provided]", don't ask follow-up
    if (!studentAnswer.trim() || studentAnswer.includes('[No Answer Provided]')) {
      return res.json({ followUpQuestion: null });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.json({ followUpQuestion: null });
    }

    let pdfText = '';
    if (documentId) {
      const doc = await Document.findOne({ _id: documentId, uploader: req.user._id });
      if (doc) pdfText = await extractPdfText(doc);
    }

    const prompt = `You are conducting a live oral viva interview with a student.
Topic: ${topic || 'Academic concept'}
Question asked: "${currentQuestion}"
Student's answer: "${studentAnswer}"

Evaluate if a targeted follow-up question is warranted to probe deeper into their reasoning, clarify an ambiguous statement, or ask for a real-world example.
If a follow-up is beneficial, respond with a JSON object:
{ "hasFollowUp": true, "followUpQuestion": "Your short follow-up question here" }
If the answer was already comprehensive or if moving to the next question is better, respond with:
{ "hasFollowUp": false, "followUpQuestion": null }

Context Material:
${pdfText ? pdfText.substring(0, 5000) : 'General concepts'}`;

    const textOut = await generateWithGemini(prompt);
    const parsed = extractJsonFromText(textOut);

    res.json({
      hasFollowUp: !!parsed?.hasFollowUp,
      followUpQuestion: parsed?.hasFollowUp ? parsed.followUpQuestion : null
    });
  } catch (error) {
    console.warn('generateFollowUpQuestion warning:', error.message);
    res.json({ hasFollowUp: false, followUpQuestion: null });
  }
};

const evaluateInterviewSession = async (req, res) => {
  try {
    const { 
      documentId, 
      studentAnswersArray = [], 
      totalTime = 0, 
      focusedTime = 0, 
      distractedTime = 0, 
      faceDetectionLog = 'Consistent', 
      distractionEvents = 0, 
      tabSwitchCount = 0,
      difficultyLevel = 'medium',
      topic = 'General'
    } = req.body;

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ message: 'GEMINI_API_KEY is not configured.' });
    }

    let pdfText = '';
    let doc = null;
    if (documentId) {
      doc = await Document.findOne({ _id: documentId, uploader: req.user._id });
      if (doc) pdfText = await extractPdfText(doc);
    }

    const calculatedFocusPct = totalTime > 0 ? Math.min(100, Math.round((focusedTime / totalTime) * 100)) : 100;

    const prompt = `You are an expert university examiner evaluating a student's live viva / oral interview for PrepDeck.

Input Data:
1. Topic / Material Text:
${pdfText || 'Evaluate subject matter based on standard curriculum for: ' + (doc?.subject || topic)}

2. Student Q&A:
${JSON.stringify(studentAnswersArray, null, 2)}

3. Focus & Discipline Data:
- Total Study/Interview Duration: ${totalTime} ms
- Focused Duration: ${focusedTime} ms
- Distracted Duration: ${distractedTime} ms
- Focus Score: ${calculatedFocusPct}%
- Distraction Events: ${distractionEvents}
- Tab Switches: ${tabSwitchCount}

Evaluation Tasks:
1. For each question, score the student's answer out of 10. Determine correctness ('Correct', 'Partially Correct', 'Incorrect'). Provide an expected ideal answer and clear feedback on what was good and what was missing.
2. Determine average score out of 10.
3. Classify discipline level: 'Highly Focused' (>=80%), 'Moderately Focused' (50-79%), or 'Needs Attention' (<50%).
4. Provide an overall summary, 2-3 specific strengths, 2-3 weaknesses, a behavior analysis based on the focus data, and 2 actionable suggestions for improvement.

Strict Output JSON structure (no markdown fences, strictly raw JSON):
{
  "evaluation": [
    {
      "question": "...",
      "student_answer": "...",
      "expected_answer": "...",
      "score": 8,
      "correctness": "Correct",
      "feedback": "..."
    }
  ],
  "report": {
    "average_score": 8.0,
    "focus_percentage": ${calculatedFocusPct},
    "discipline_level": "Highly Focused",
    "summary": "...",
    "strengths": ["...", "..."],
    "weaknesses": ["...", "..."],
    "behavior_analysis": "...",
    "suggestions": ["...", "..."]
  }
}`;

    const textOut = await generateWithGemini(prompt);
    const finalJson = extractJsonFromText(textOut);

    // Persist to MongoDB InterviewAttempt collection!
    const questionsForDb = (finalJson.evaluation || []).map(e => ({
      question: e.question,
      studentAnswer: e.student_answer,
      expectedAnswer: e.expected_answer,
      score: e.score,
      correctness: e.correctness,
      feedback: e.feedback
    }));

    const attempt = await InterviewAttempt.create({
      user: req.user._id,
      document: documentId || null,
      topic: topic || doc?.subject || 'General',
      difficultyLevel: difficultyLevel || 'medium',
      score: finalJson.report?.average_score || 0,
      totalQuestions: questionsForDb.length,
      disciplineLevel: finalJson.report?.discipline_level || 'Moderately Focused',
      focusPercentage: finalJson.report?.focus_percentage || calculatedFocusPct,
      questions: questionsForDb,
      report: finalJson.report || {},
      sessionStats: {
        totalTimeMs: totalTime,
        focusedTimeMs: focusedTime,
        distractedTimeMs: distractedTime,
        distractionEvents
      }
    });

    res.json({
      ...finalJson,
      attemptId: attempt._id
    });
  } catch (error) {
    console.error('evaluateInterviewSession error:', error);
    res.status(500).json({ message: error.message || 'Evaluation failed' });
  }
};

const getInterviewHistory = async (req, res) => {
  try {
    const history = await InterviewAttempt.find({ user: req.user._id })
      .populate('document', 'subject originalName type semester')
      .sort({ attemptedAt: -1 });
    res.json(history);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const generateQuiz = async (req, res) => {
  try {
    const { documentId, difficultyLevel = 'medium' } = req.body;
    const doc = await Document.findOne({ _id: documentId, uploader: req.user._id });
    if (!doc) return res.status(404).json({ message: 'Document not found or access denied' });

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ message: 'GEMINI_API_KEY is not configured.' });
    }

    const pdfText = await extractPdfText(doc);

    const prompt = `Based exclusively on this study material text, generate a quiz with 3 MCQs (Multiple Choice), 2 True/False, and 2 Short Answer questions. The difficulty should be ${difficultyLevel}.
Return strictly a valid JSON array of objects with no markdown backticks.
Each object must follow this exact structure:
{
  "questionText": "...",
  "questionType": "MCQ" | "TF" | "ShortAnswer",
  "options": ["Option A", "Option B", "Option C", "Option D"], // for MCQ: 4 options. For TF: ["True", "False"]. For ShortAnswer: []
  "correctAnswer": "...",
  "explanation": "..."
}
Material Text:
${pdfText || 'Generate academic questions based on ' + doc.subject}`;

    const textOut = await generateWithGemini(prompt);
    const questions = extractJsonFromText(textOut);

    res.json({ questions });
  } catch (error) {
    console.error('generateQuiz error:', error);
    res.status(500).json({ message: error.message || 'Failed to generate quiz' });
  }
};

const evaluateQuiz = async (req, res) => {
  try {
    const { documentId, difficultyLevel = 'medium', questionsAndAnswers = [] } = req.body;

    if (documentId) {
      const doc = await Document.findOne({ _id: documentId, uploader: req.user._id });
      if (!doc) return res.status(404).json({ message: 'Document not found or access denied' });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ message: 'GEMINI_API_KEY is not configured.' });
    }

    const prompt = `Evaluate the following quiz attempt.
For MCQs and TF questions, check if studentAnswer strictly matches correctAnswer (or option text).
For ShortAnswer, evaluate leniently whether the student captured the key concept.
Provide an encouraging and constructive performanceSummary.

Input Data:
${JSON.stringify(questionsAndAnswers, null, 2)}

Return strictly a valid JSON object:
{
  "evaluatedQuestions": [
    {
      "questionText": "...",
      "questionType": "MCQ",
      "options": ["..."],
      "correctAnswer": "...",
      "studentAnswer": "...",
      "isCorrect": true,
      "explanation": "..."
    }
  ],
  "performanceSummary": "..."
}`;

    const textOut = await generateWithGemini(prompt);
    const evaluation = extractJsonFromText(textOut);

    const score = (evaluation.evaluatedQuestions || []).filter(q => q.isCorrect).length;

    const attempt = await QuizAttempt.create({
      user: req.user._id,
      document: documentId,
      difficultyLevel,
      score,
      totalQuestions: evaluation.evaluatedQuestions?.length || questionsAndAnswers.length,
      questions: evaluation.evaluatedQuestions || questionsAndAnswers,
      performanceSummary: evaluation.performanceSummary || 'Quiz completed.'
    });

    res.status(201).json(attempt);
  } catch (error) {
    console.error('evaluateQuiz error:', error);
    res.status(500).json({ message: error.message || 'Quiz evaluation failed' });
  }
};

const getQuizHistory = async (req, res) => {
  try {
    const { documentId } = req.params;
    const history = await QuizAttempt.find({ user: req.user._id, document: documentId }).sort({ attemptedAt: -1 });
    res.json(history);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getStudySessionsHistory = async (req, res) => {
  try {
    const sessions = await StudySession.find({ user: req.user._id })
      .populate('document')
      .sort({ startTime: -1 });
    res.json(sessions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getAllQuizHistory = async (req, res) => {
  try {
    const attempts = await QuizAttempt.find({ user: req.user._id })
      .populate('document')
      .sort({ attemptedAt: -1 });
    res.json(attempts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { 
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
};
