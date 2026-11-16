const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// POST /auth/login  { loginId, password }
// loginId = roll number (student) or employee ID (staff/admin)
router.post('/login', async (req, res) => {
  try {
    const { loginId, password } = req.body;
    if (!loginId || !password) {
      return res.status(400).json({ message: 'loginId and password are required' });
    }

    const user = await prisma.user.findUnique({
      where: { loginId: String(loginId).trim().toUpperCase() },
      include: { department: true },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ message: 'Invalid ID or password' });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ message: 'Invalid ID or password' });

    const token = jwt.sign(
      { id: user.id, loginId: user.loginId, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        loginId: user.loginId,
        name: user.name,
        role: user.role,
        email: user.email,
        phone: user.phone,
        department: user.department ? user.department.name : null,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Something went wrong' });
  }
});

// GET /auth/me
router.get('/me', authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { department: true },
  });
  if (!user) return res.status(404).json({ message: 'User not found' });
  const { passwordHash, ...safe } = user;
  res.json(safe);
});

// POST /auth/device-token  { token, platform }  (FCM token for push notifications)
router.post('/device-token', authenticate, async (req, res) => {
  const { token, platform } = req.body;
  if (!token) return res.status(400).json({ message: 'token is required' });

  await prisma.deviceToken.upsert({
    where: { token },
    update: { userId: req.user.id, platform },
    create: { userId: req.user.id, token, platform },
  });
  res.json({ message: 'Device token saved' });
});

// POST /auth/change-password  { oldPassword, newPassword }
router.post('/change-password', authenticate, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ message: 'New password must be at least 6 characters' });
  }
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  const ok = await bcrypt.compare(oldPassword, user.passwordHash);
  if (!ok) return res.status(401).json({ message: 'Old password is wrong' });

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(newPassword, 10) },
  });
  res.json({ message: 'Password updated' });
});

module.exports = router;
