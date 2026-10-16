const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadsDir = path.resolve(process.env.STORAGE_PATH || path.join(__dirname, '../uploads'));
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, uploadsDir);
  },
  filename(req, file, cb) {
    // Sanitize originalname to prevent path traversal or special character issues
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  }
});

const checkFileType = (file, cb) => {
  const allowedExts = /\.(pdf|txt|docx|doc)$/i;
  const isExtAllowed = allowedExts.test(path.extname(file.originalname));
  const allowedMimes = [
    'application/pdf',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword'
  ];
  const isMimeAllowed = allowedMimes.includes(file.mimetype) || file.mimetype.startsWith('text/');

  if (isExtAllowed || isMimeAllowed) {
    return cb(null, true);
  } else {
    cb(new Error('Supported formats: PDF, TXT, and DOCX files only!'));
  }
};

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: function (req, file, cb) {
    checkFileType(file, cb);
  }
});

module.exports = upload;
