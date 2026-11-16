const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// All admin routes need login + ADMIN role
router.use(authenticate, requireRole('ADMIN'));

/* ---------------- Grievance Types ---------------- */

// GET /admin/grievance-types
router.get('/grievance-types', async (req, res) => {
  const types = await prisma.grievanceType.findMany({
    orderBy: { name: 'asc' },
    include: { rules: { include: { user: { select: { loginId: true, name: true } } } } },
  });
  res.json(types);
});

// POST /admin/grievance-types  { name, description, needsHod, escalateAfterHours }
router.post('/grievance-types', async (req, res) => {
  const { name, description, needsHod, escalateAfterHours } = req.body;
  if (!name) return res.status(400).json({ message: 'name is required' });
  try {
    const type = await prisma.grievanceType.create({
      data: {
        name: name.trim(),
        description,
        needsHod: !!needsHod,
        escalateAfterHours: escalateAfterHours || 72,
      },
    });
    res.status(201).json(type);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ message: 'This type already exists' });
    console.error(err);
    res.status(500).json({ message: 'Something went wrong' });
  }
});

// PUT /admin/grievance-types/:id
router.put('/grievance-types/:id', async (req, res) => {
  const { name, description, needsHod, escalateAfterHours, isActive } = req.body;
  try {
    const type = await prisma.grievanceType.update({
      where: { id: req.params.id },
      data: { name, description, needsHod, escalateAfterHours, isActive },
    });
    res.json(type);
  } catch (err) {
    res.status(404).json({ message: 'Grievance type not found' });
  }
});

/* ---------------- Routing Rules ---------------- */

// POST /admin/routing-rules
// { grievanceTypeId, empId, routeRole: "PRIMARY"|"SECONDARY"|"HOD", level }
// For routeRole HOD, empId is not needed (HOD is picked from the student's department).
router.post('/routing-rules', async (req, res) => {
  const { grievanceTypeId, empId, routeRole, level } = req.body;
  if (!grievanceTypeId || !routeRole) {
    return res.status(400).json({ message: 'grievanceTypeId and routeRole are required' });
  }
  if (!['PRIMARY', 'SECONDARY', 'HOD'].includes(routeRole)) {
    return res.status(400).json({ message: 'routeRole must be PRIMARY, SECONDARY or HOD' });
  }

  let userId = null;
  if (routeRole !== 'HOD') {
    if (!empId) return res.status(400).json({ message: 'empId is required for PRIMARY / SECONDARY' });
    const person = await prisma.user.findUnique({ where: { loginId: String(empId).trim().toUpperCase() } });
    if (!person) return res.status(404).json({ message: 'No user found with this empId' });
    userId = person.id;
  }

  const rule = await prisma.routingRule.create({
    data: { grievanceTypeId, userId, routeRole, level: level || 1 },
  });

  if (routeRole === 'HOD') {
    await prisma.grievanceType.update({ where: { id: grievanceTypeId }, data: { needsHod: true } });
  }
  res.status(201).json(rule);
});

// GET /admin/routing-rules?grievanceTypeId=...
router.get('/routing-rules', async (req, res) => {
  const where = req.query.grievanceTypeId ? { grievanceTypeId: req.query.grievanceTypeId } : {};
  const rules = await prisma.routingRule.findMany({
    where,
    orderBy: [{ level: 'asc' }],
    include: {
      grievanceType: { select: { name: true } },
      user: { select: { loginId: true, name: true, email: true, phone: true } },
    },
  });
  res.json(rules);
});

// DELETE /admin/routing-rules/:id
router.delete('/routing-rules/:id', async (req, res) => {
  try {
    await prisma.routingRule.delete({ where: { id: req.params.id } });
    res.json({ message: 'Rule removed' });
  } catch (err) {
    res.status(404).json({ message: 'Rule not found' });
  }
});

/* ---------------- Departments ---------------- */

// GET /admin/departments
router.get('/departments', async (req, res) => {
  const list = await prisma.department.findMany({
    orderBy: { name: 'asc' },
    include: { hod: { select: { loginId: true, name: true } } },
  });
  res.json(list);
});

// POST /admin/departments  { name }
router.post('/departments', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ message: 'name is required' });
  try {
    const dep = await prisma.department.create({ data: { name: name.trim().toUpperCase() } });
    res.status(201).json(dep);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ message: 'Department already exists' });
    res.status(500).json({ message: 'Something went wrong' });
  }
});

// PUT /admin/departments/:id/hod  { empId }
router.put('/departments/:id/hod', async (req, res) => {
  const { empId } = req.body;
  if (!empId) return res.status(400).json({ message: 'empId is required' });
  const person = await prisma.user.findUnique({ where: { loginId: String(empId).trim().toUpperCase() } });
  if (!person) return res.status(404).json({ message: 'No user found with this empId' });
  try {
    const dep = await prisma.department.update({
      where: { id: req.params.id },
      data: { hodId: person.id },
    });
    res.json(dep);
  } catch (err) {
    res.status(400).json({ message: 'Could not set HOD (department not found, or this person is already HOD of another department)' });
  }
});

/* ---------------- Users ---------------- */

// GET /admin/users?role=STUDENT
router.get('/users', async (req, res) => {
  const where = req.query.role ? { role: req.query.role } : {};
  const users = await prisma.user.findMany({
    where,
    orderBy: { loginId: 'asc' },
    select: { id: true, loginId: true, name: true, role: true, email: true, phone: true, isActive: true,
              department: { select: { name: true } } },
  });
  res.json(users);
});

// POST /admin/users  { loginId, name, role, email, phone, department, password }
router.post('/users', async (req, res) => {
  const { loginId, name, role, email, phone, department, password } = req.body;
  if (!loginId || !name || !role) {
    return res.status(400).json({ message: 'loginId, name and role are required' });
  }
  if (!['STUDENT', 'STAFF', 'ADMIN'].includes(role)) {
    return res.status(400).json({ message: 'role must be STUDENT, STAFF or ADMIN' });
  }

  let departmentId = null;
  if (department) {
    const dep = await prisma.department.findUnique({ where: { name: String(department).trim().toUpperCase() } });
    if (!dep) return res.status(404).json({ message: 'Department not found. Create it first.' });
    departmentId = dep.id;
  }

  try {
    const user = await prisma.user.create({
      data: {
        loginId: String(loginId).trim().toUpperCase(),
        name,
        role,
        email: email || null,
        phone: phone || null,
        departmentId,
        passwordHash: await bcrypt.hash(password || 'password123', 10),
      },
      select: { id: true, loginId: true, name: true, role: true },
    });
    res.status(201).json(user);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ message: 'loginId or email already exists' });
    console.error(err);
    res.status(500).json({ message: 'Something went wrong' });
  }
});


/* ---------------- Dashboard: stats + all complaints ---------------- */

const OPEN_STATUSES = ['SUBMITTED', 'SEEN', 'IN_PROGRESS'];

// GET /admin/stats
router.get('/stats', async (req, res) => {
  const [byStatus, overdue, byType, types] = await Promise.all([
    prisma.complaint.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.complaint.count({ where: { status: { in: OPEN_STATUSES }, dueAt: { lt: new Date() } } }),
    prisma.complaint.groupBy({ by: ['grievanceTypeId'], _count: { _all: true } }),
    prisma.grievanceType.findMany({ select: { id: true, name: true } }),
  ]);

  const status = { SUBMITTED: 0, SEEN: 0, IN_PROGRESS: 0, RESOLVED: 0, CLOSED: 0 };
  byStatus.forEach((s) => { status[s.status] = s._count._all; });
  const total = Object.values(status).reduce((a, b) => a + b, 0);

  const nameOf = Object.fromEntries(types.map((t) => [t.id, t.name]));
  res.json({
    total,
    status,
    overdue,
    byType: byType.map((t) => ({ type: nameOf[t.grievanceTypeId] || 'Unknown', count: t._count._all })),
  });
});

// GET /admin/complaints?status=&grievanceTypeId=&overdue=true&q=
router.get('/complaints', async (req, res) => {
  const { status, grievanceTypeId, q, overdue } = req.query;
  const where = {};
  if (status) where.status = status;
  if (grievanceTypeId) where.grievanceTypeId = grievanceTypeId;
  if (overdue === 'true') {
    where.status = { in: OPEN_STATUSES };
    where.dueAt = { lt: new Date() };
  }
  if (q && q.trim()) {
    const t = q.trim();
    where.OR = [
      { ticketNo: { contains: t, mode: 'insensitive' } },
      { title: { contains: t, mode: 'insensitive' } },
      { complainant: { loginId: { contains: t, mode: 'insensitive' } } },
      { complainant: { name: { contains: t, mode: 'insensitive' } } },
    ];
  }

  const list = await prisma.complaint.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      grievanceType: { select: { name: true } },
      complainant: { select: { name: true, loginId: true, department: { select: { name: true } } } },
      assignedTo: { select: { name: true } },
    },
  });
  res.json(list);
});

module.exports = router;
