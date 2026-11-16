const express = require('express');
const prisma = require('../config/prisma');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

/* ---------------- Helpers ---------------- */

const complainantSelect = {
  id: true, loginId: true, name: true, email: true, phone: true,
  department: { select: { name: true, hodId: true } },
};

// Who should be notified for this complaint at the given level?
async function findRecipients(grievanceTypeId, complainantId, level) {
  const rules = await prisma.routingRule.findMany({ where: { grievanceTypeId, level } });
  const complainant = await prisma.user.findUnique({
    where: { id: complainantId },
    include: { department: true },
  });

  const ids = new Set();
  for (const r of rules) {
    if (r.routeRole === 'HOD') {
      if (complainant.department && complainant.department.hodId) ids.add(complainant.department.hodId);
    } else if (r.userId) {
      ids.add(r.userId);
    }
  }
  ids.delete(complainantId); // never notify the person who raised it
  return [...ids];
}

// Save in-app notifications (push via FCM will be added later)
async function notify(userIds, complaintId, title, body) {
  if (!userIds.length) return;
  await prisma.notification.createMany({
    data: userIds.map((userId) => ({ userId, complaintId, channel: 'PUSH', title, body })),
  });
  console.log(`[notify] ${userIds.length} user(s): ${title}`);
}

// Is this user one of the people the complaint was routed to?
// (complaint must be loaded with grievanceType.rules and complainant.department)
function isRecipient(userId, c) {
  return c.grievanceType.rules.some((r) => {
    if (r.level > c.currentLevel) return false;
    if (r.routeRole === 'HOD') {
      return c.complainant.department && c.complainant.department.hodId === userId;
    }
    return r.userId === userId;
  });
}

const fullInclude = {
  grievanceType: { include: { rules: true } },
  complainant: { select: complainantSelect },
  assignedTo: { select: { id: true, loginId: true, name: true } },
};

async function loadComplaint(id) {
  return prisma.complaint.findUnique({ where: { id }, include: fullInclude });
}

function canView(user, c) {
  return (
    user.role === 'ADMIN' ||
    c.complainantId === user.id ||
    c.assignedToId === user.id ||
    isRecipient(user.id, c)
  );
}

async function addHistory(complaintId, status, note, changedById) {
  await prisma.statusHistory.create({ data: { complaintId, status, note, changedById } });
}

/* ---------------- Routes ---------------- */

// GET /complaints/types  -> grievance types for the dropdown
router.get('/types', async (req, res) => {
  const types = await prisma.grievanceType.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, description: true },
  });
  res.json(types);
});

// POST /complaints  { grievanceTypeId, title, description }
router.post('/', async (req, res) => {
  try {
    const { grievanceTypeId, title, description } = req.body;
    if (!grievanceTypeId || !title || !description) {
      return res.status(400).json({ message: 'grievanceTypeId, title and description are required' });
    }

    const type = await prisma.grievanceType.findUnique({ where: { id: grievanceTypeId } });
    if (!type || !type.isActive) return res.status(404).json({ message: 'Grievance type not found' });

    const recipients = await findRecipients(grievanceTypeId, req.user.id, 1);
    if (!recipients.length) {
      return res.status(400).json({ message: 'No concerned person is set for this type yet. Please contact admin.' });
    }

    const year = new Date().getFullYear();
    const count = await prisma.complaint.count();
    const ticketNo = `GRV-${year}-${String(count + 1).padStart(5, '0')}`;
    const dueAt = new Date(Date.now() + type.escalateAfterHours * 60 * 60 * 1000);

    const complaint = await prisma.complaint.create({
      data: {
        ticketNo, grievanceTypeId, title, description,
        complainantId: req.user.id, dueAt,
      },
    });
    await addHistory(complaint.id, 'SUBMITTED', 'Complaint raised', req.user.id);

    const me = await prisma.user.findUnique({ where: { id: req.user.id } });
    await notify(
      recipients, complaint.id,
      `New ${type.name} complaint`,
      `${me.name} (${me.loginId}): ${title}`
    );

    res.status(201).json({ ...complaint, notifiedCount: recipients.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Something went wrong' });
  }
});

// GET /complaints/my  -> complaints raised by me
router.get('/my', async (req, res) => {
  const list = await prisma.complaint.findMany({
    where: { complainantId: req.user.id },
    orderBy: { createdAt: 'desc' },
    include: {
      grievanceType: { select: { name: true } },
      assignedTo: { select: { name: true } },
    },
  });
  res.json(list);
});

// GET /complaints/assigned  -> complaints routed to me (staff)
router.get('/assigned', async (req, res) => {
  const candidates = await prisma.complaint.findMany({
    where: {
      OR: [
        { assignedToId: req.user.id },
        { grievanceType: { rules: { some: { userId: req.user.id } } } },
        { complainant: { department: { hodId: req.user.id } } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    include: fullInclude,
  });

  let list = candidates.filter((c) => c.assignedToId === req.user.id || isRecipient(req.user.id, c));
  if (req.query.status) list = list.filter((c) => c.status === req.query.status);

  res.json(list.map(({ grievanceType, ...c }) => ({ ...c, grievanceType: { name: grievanceType.name } })));
});

// GET /complaints/:id
router.get('/:id', async (req, res) => {
  const c = await loadComplaint(req.params.id);
  if (!c) return res.status(404).json({ message: 'Complaint not found' });
  if (!canView(req.user, c)) return res.status(403).json({ message: 'Access denied' });

  const [comments, history] = await Promise.all([
    prisma.complaintComment.findMany({
      where: { complaintId: c.id }, orderBy: { createdAt: 'asc' },
      include: { author: { select: { name: true, loginId: true } } },
    }),
    prisma.statusHistory.findMany({ where: { complaintId: c.id }, orderBy: { createdAt: 'asc' } }),
  ]);

  const { grievanceType, ...rest } = c;
  res.json({ ...rest, grievanceType: { name: grievanceType.name }, comments, history });
});

// PATCH /complaints/:id/accept  -> "Take" this complaint
router.patch('/:id/accept', async (req, res) => {
  const c = await loadComplaint(req.params.id);
  if (!c) return res.status(404).json({ message: 'Complaint not found' });
  if (!isRecipient(req.user.id, c)) return res.status(403).json({ message: 'This complaint is not assigned to you' });
  if (c.assignedToId) {
    return res.status(409).json({ message: `Already taken by ${c.assignedTo.name}` });
  }

  const me = await prisma.user.findUnique({ where: { id: req.user.id } });
  await prisma.complaint.update({
    where: { id: c.id },
    data: { assignedToId: req.user.id, status: 'IN_PROGRESS' },
  });
  await addHistory(c.id, 'IN_PROGRESS', `Taken by ${me.name}`, req.user.id);

  // tell the complainant and the other concerned persons
  const others = (await findRecipients(c.grievanceTypeId, c.complainantId, c.currentLevel))
    .filter((id) => id !== req.user.id);
  await notify([c.complainantId, ...others], c.id, 'Complaint taken', `${c.ticketNo} is taken by ${me.name}`);

  res.json({ message: `Taken by ${me.name}` });
});

// PATCH /complaints/:id/status  { status: "IN_PROGRESS"|"RESOLVED"|"CLOSED", note }
router.patch('/:id/status', async (req, res) => {
  const { status, note } = req.body;
  if (!['IN_PROGRESS', 'RESOLVED', 'CLOSED'].includes(status)) {
    return res.status(400).json({ message: 'status must be IN_PROGRESS, RESOLVED or CLOSED' });
  }
  const c = await loadComplaint(req.params.id);
  if (!c) return res.status(404).json({ message: 'Complaint not found' });
  if (req.user.role !== 'ADMIN' && c.assignedToId !== req.user.id) {
    return res.status(403).json({ message: 'Only the person who took this complaint can update it' });
  }

  await prisma.complaint.update({
    where: { id: c.id },
    data: { status, resolvedAt: status === 'RESOLVED' ? new Date() : c.resolvedAt },
  });
  await addHistory(c.id, status, note || null, req.user.id);
  await notify([c.complainantId], c.id, 'Complaint update', `${c.ticketNo} is now ${status.replace('_', ' ')}`);

  res.json({ message: 'Status updated', status });
});

// POST /complaints/:id/comments  { message }
router.post('/:id/comments', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ message: 'message is required' });

  const c = await loadComplaint(req.params.id);
  if (!c) return res.status(404).json({ message: 'Complaint not found' });
  if (!canView(req.user, c)) return res.status(403).json({ message: 'Access denied' });

  const comment = await prisma.complaintComment.create({
    data: { complaintId: c.id, authorId: req.user.id, message },
  });

  if (req.user.id === c.complainantId) {
    const targets = c.assignedToId
      ? [c.assignedToId]
      : await findRecipients(c.grievanceTypeId, c.complainantId, c.currentLevel);
    await notify(targets, c.id, 'New reply on complaint', `${c.ticketNo}: ${message.slice(0, 80)}`);
  } else {
    await notify([c.complainantId], c.id, 'New reply on your complaint', `${c.ticketNo}: ${message.slice(0, 80)}`);
  }

  res.status(201).json(comment);
});

module.exports = router;
