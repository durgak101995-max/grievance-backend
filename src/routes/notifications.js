const express = require('express');
const prisma = require('../config/prisma');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /notifications  (latest 50, unread count)
router.get('/', async (req, res) => {
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { sentAt: 'desc' },
      take: 50,
    }),
    prisma.notification.count({ where: { userId: req.user.id, isRead: false } }),
  ]);
  res.json({ unread, items });
});

// PATCH /notifications/read-all
router.patch('/read-all', async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: req.user.id, isRead: false }, data: { isRead: true } });
  res.json({ message: 'All marked as read' });
});

// PATCH /notifications/:id/read
router.patch('/:id/read', async (req, res) => {
  const result = await prisma.notification.updateMany({
    where: { id: req.params.id, userId: req.user.id },
    data: { isRead: true },
  });
  if (!result.count) return res.status(404).json({ message: 'Notification not found' });
  res.json({ message: 'Marked as read' });
});

module.exports = router;
