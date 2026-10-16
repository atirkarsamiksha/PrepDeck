const Document = require('../models/Document');
const fs = require('fs');
const path = require('path');

const uploadDocument = async (req, res) => {
  try {
    const { subject, semester, type, year, examType } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded or file was rejected (PDF only)' });
    }

    const cleanSubject = (subject && subject.trim()) ? subject.trim() : 'General';
    const cleanSemester = (semester && semester.toString().trim()) ? semester.toString().trim() : '1';
    const normalizedType = (type && type.toString().toLowerCase() === 'pyq') ? 'PYQ' : 'Note';

    let validatedYear = undefined;
    let validatedExamType = undefined;

    if (normalizedType === 'PYQ') {
      validatedYear = (year && year.toString().trim()) ? year.toString().trim() : new Date().getFullYear().toString();
      const validExamTypes = ['midsem', 'endsem', 'backlog'];
      const rawExam = (examType || '').toString().toLowerCase().trim();
      validatedExamType = validExamTypes.includes(rawExam) ? rawExam : 'midsem';
    }

    const newDoc = await Document.create({
      filename: req.file.filename,
      originalName: req.file.originalname,
      subject: cleanSubject,
      semester: cleanSemester,
      type: normalizedType,
      year: validatedYear,
      examType: validatedExamType,
      uploader: req.user._id,
      filepath: `/uploads/${req.file.filename}`
    });

    res.status(201).json(newDoc);
  } catch (error) {
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (unlinkErr) { /* ignore */ }
    }
    res.status(500).json({ message: error.message || 'Failed to save document' });
  }
};

const getDocuments = async (req, res) => {
  try {
    const { type, subject, semester, year, examType } = req.query;
    
    let query = { uploader: req.user._id };
    if (type) query.type = type;
    if (subject) query.subject = { $regex: subject, $options: 'i' };
    if (semester) query.semester = semester;
    if (year) query.year = year;
    if (examType) query.examType = examType;

    const docs = await Document.find(query).sort({ uploadDate: -1 }).populate('uploader', 'name email');
    res.json(docs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getFilteredNotes = async (req, res) => {
  try {
    const { semester, subject } = req.query;
    let query = { type: 'Note', uploader: req.user._id };
    
    if (semester) query.semester = semester;
    if (subject) query.subject = { $regex: subject, $options: 'i' };

    const notes = await Document.find(query).sort({ uploadDate: -1 }).populate('uploader', 'name email');
    res.json(notes);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getFilteredPyqs = async (req, res) => {
  try {
    const { year, subject, examType } = req.query;
    let query = { type: 'PYQ', uploader: req.user._id };
    
    if (year) query.year = year;
    if (examType) query.examType = examType;
    if (subject) query.subject = { $regex: subject, $options: 'i' };

    const pyqs = await Document.find(query).sort({ uploadDate: -1 }).populate('uploader', 'name email');
    res.json(pyqs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getDocumentById = async (req, res) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, uploader: req.user._id });
    if (doc) {
      res.json(doc);
    } else {
      res.status(404).json({ message: 'Document not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const streamDocumentFile = async (req, res) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, uploader: req.user._id });
    if (!doc) {
      return res.status(404).json({ message: 'Document not found or access denied' });
    }

    const uploadsDir = path.resolve(process.env.STORAGE_PATH || path.join(__dirname, '../uploads'));
    const safeFilename = path.basename(doc.filename);
    const targetFile = path.resolve(uploadsDir, safeFilename);

    // Guard against path traversal attacks
    if (!targetFile.startsWith(uploadsDir)) {
      return res.status(403).json({ message: 'Access denied: Invalid file path' });
    }

    if (!fs.existsSync(targetFile)) {
      return res.status(404).json({ message: 'File not found on storage server' });
    }

    const stat = fs.statSync(targetFile);
    const ext = path.extname(doc.originalName || safeFilename).toLowerCase();
    let contentType = 'application/pdf';
    if (ext === '.txt') contentType = 'text/plain; charset=utf-8';
    else if (ext === '.docx') contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    else if (ext === '.doc') contentType = 'application/msword';
    else if (ext === '.pdf') contentType = 'application/pdf';
    else contentType = 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stat.size);
    const cleanOriginalName = (doc.originalName || safeFilename).replace(/["\r\n]/g, '_');
    const encodedFilename = encodeURIComponent(cleanOriginalName);
    const isDownload = req.query && (req.query.download === 'true' || req.query.download === '1');
    const dispositionType = isDownload ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${dispositionType}; filename="${cleanOriginalName}"; filename*=UTF-8''${encodedFilename}`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    const stream = fs.createReadStream(targetFile);
    stream.on('error', (streamErr) => {
      console.error('File stream error:', streamErr);
      if (!res.headersSent) res.status(500).json({ message: 'Error streaming document' });
    });
    stream.pipe(res);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteDocument = async (req, res) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, uploader: req.user._id });
    if (!doc) {
      return res.status(404).json({ message: 'Document not found or access denied' });
    }

    // Attempt to unlink physical file safely
    const uploadsDir = path.resolve(process.env.STORAGE_PATH || path.join(__dirname, '../uploads'));
    const safeFilename = path.basename(doc.filename);
    const absolutePath = path.resolve(uploadsDir, safeFilename);
    if (absolutePath.startsWith(uploadsDir) && fs.existsSync(absolutePath)) {
      try {
        fs.unlinkSync(absolutePath);
      } catch (err) {
        console.warn('Could not remove file on disk:', err.message);
      }
    }

    await Document.findByIdAndDelete(req.params.id);
    res.json({ message: 'Document deleted successfully', id: req.params.id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const syncUploadsToDb = async (userId) => {
  try {
    const uploadsDir = path.resolve(process.env.STORAGE_PATH || path.join(__dirname, '../uploads'));
    if (!fs.existsSync(uploadsDir)) return [];

    const files = fs.readdirSync(uploadsDir).filter(f => f.toLowerCase().endsWith('.pdf'));
    const synced = [];

    for (const filename of files) {
      const existing = await Document.findOne({ filename });
      if (!existing) {
        // Parse original name from timestamp prefix (e.g. 1775196874081-Matrices.pdf)
        const parts = filename.split('-');
        let originalName = parts.length > 1 ? parts.slice(1).join('-') : filename;
        let baseNameWithoutExt = originalName.replace(/\.pdf$/i, '').trim();

        const isPyq = /pyq|sem|exam|question|dec|oct|2023|2024/i.test(baseNameWithoutExt) && (baseNameWithoutExt.includes('2023') || baseNameWithoutExt.includes('2024') || baseNameWithoutExt.includes('SEM'));
        
        let subject = baseNameWithoutExt;
        let semester = '3';
        let year = null;
        let examType = null;

        if (isPyq) {
          if (baseNameWithoutExt.includes('Applied Mathematics')) subject = 'Applied Mathematics';
          else if (baseNameWithoutExt.includes('Data Structures')) subject = 'Data Structures';
          else if (baseNameWithoutExt.includes('Computer Organization')) subject = 'Computer Organization and Architecture';
          else if (baseNameWithoutExt.includes('Computer Graphics')) subject = 'Computer Graphics';
          else subject = baseNameWithoutExt;

          if (baseNameWithoutExt.includes('2024')) year = '2024';
          else if (baseNameWithoutExt.includes('2023')) year = '2023';
          else year = '2024';

          examType = 'endsem';
        } else {
          if (baseNameWithoutExt.toLowerCase().includes('matrices')) subject = 'Matrices';
          else if (baseNameWithoutExt.toLowerCase().includes('dbms')) subject = 'Database Management Systems';
          else if (baseNameWithoutExt.toLowerCase().includes('practical')) subject = 'Practical Lab';
        }

        const newDoc = await Document.create({
          filename,
          originalName,
          subject,
          semester,
          type: isPyq ? 'PYQ' : 'Note',
          year,
          examType,
          uploader: userId,
          filepath: `/uploads/${filename}`
        });
        synced.push(newDoc);
      }
    }
    return synced;
  } catch (error) {
    console.error('Error syncing uploads to DB:', error);
    return [];
  }
};

module.exports = { 
  uploadDocument, 
  getDocuments, 
  getDocumentById, 
  getFilteredNotes, 
  getFilteredPyqs,
  deleteDocument,
  streamDocumentFile,
  syncUploadsToDb
};
