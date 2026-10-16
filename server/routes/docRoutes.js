const express = require('express');
const router = express.Router();
const { 
  uploadDocument, 
  getDocuments, 
  getDocumentById, 
  deleteDocument,
  streamDocumentFile,
  syncUploadsToDb
} = require('../controllers/docController');
const { protect } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');

const multer = require('multer');

router.post('/upload', protect, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ message: 'File too large. Maximum allowed size is 50MB.' });
        }
        return res.status(400).json({ message: `Upload error: ${err.message}` });
      }
      return res.status(400).json({ message: err.message || 'File upload failed.' });
    }
    next();
  });
}, uploadDocument);
router.get('/', protect, getDocuments);
router.get('/:id', protect, getDocumentById);
router.get('/:id/file', protect, streamDocumentFile);
router.delete('/:id', protect, deleteDocument);
router.post('/sync', protect, async (req, res) => {
  try {
    const synced = await syncUploadsToDb(req.user._id);
    res.json({ message: `Synced ${synced.length} documents`, synced });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
