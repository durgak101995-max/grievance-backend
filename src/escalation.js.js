const prisma = require('./config/prisma');

// If a complaint is not resolved within this many hours, it goes to the next level.
const DEFAULT_HOURS = Number(process.env.ESCALATION_HOURS || 12);
const OPEN_STATUSES = ['SUBMITTED', 'SEEN', 'IN_PROGRESS'];
const HOUR = 60 * 60 * 1000;

// People to notify at a given level (HOD is picked from the complainant's department)
async function findRecipients(grievanceTypeId, complainantId, level) {
  const rules = await prisma.routingRule.findMany({ where: { grievanceTypeId, level } });
  const complainant = await prisma.user.findUnique({
    where: { id: complainantId },
    include: { department: true },
  });

  const ids = new Set();
  for (const r of rules) {
    if (r.routeRole === 'HOD') {
      if (complainant && complainant.department && complainant.department.hodId) {
        ids.add(complainant.department.hodId);
      }
    } else if (r.userId) {
      ids.add(r.userId);
    }
  }
  ids.delete(complainantId);
  return [...ids];
}

async function notify(userIds, complaintId, title, body) {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (!unique.length) return;
  await prisma.notification.createMany({
    data: unique.map((userId) => ({ userId, complaintId, channel: 'PUSH', title, body })),
  });
}

async function runEscalation(hoursOverride) {
  const parsed = Number(hoursOverride);
  const hours = hoursOverride !== undefined && hoursOverride !== '' && !Number.isNaN(parsed) ? parsed : DEFAULT_HOURS;
  const now = new Date();

  const open = await prisma.complaint.findMany({
    where: { status: { in: OPEN_STATUSES } },
    include: { grievanceType: { select: { name: true } } },
  });

  const result = { hours, checked: open.length, escalated: 0, reminded: 0 };

  for (const c of open) {
    // time since the complaint was raised, or since it was last escalated
    const last = await prisma.statusHistory.findFirst({
      where: { complaintId: c.id, note: { startsWith: 'Escalat' } },
      orderBy: { createdAt: 'desc' },
    });
    const base = last ? last.createdAt : c.createdAt;
    const deadline = new Date(base.getTime() + hours * HOUR);

    if (now < deadline) {
      // keep the "overdue" date in sync for the admin dashboard
      if (!c.dueAt || Math.abs(c.dueAt.getTime() - deadline.getTime()) > 60 * 1000) {
        await prisma.complaint.update({ where: { id: c.id }, data: { dueAt: deadline } });
      }
      continue;
    }

    const nextLevel = c.currentLevel + 1;
    const nextPeople = await findRecipients(c.grievanceTypeId, c.complainantId, nextLevel);
    const newDue = new Date(now.getTime() + hours * HOUR);

    if (nextPeople.length) {
      // move to the next authority; they can take it fresh
      await prisma.complaint.update({
        where: { id: c.id },
        data: { currentLevel: nextLevel, assignedToId: null, status: 'SUBMITTED', dueAt: newDue },
      });
      await prisma.statusHistory.create({
        data: {
          complaintId: c.id, status: 'SUBMITTED',
          note: `Escalated to level ${nextLevel} (not resolved in ${hours} hours)`,
        },
      });
      await notify(
        nextPeople, c.id, 'Escalated complaint',
        `${c.ticketNo} (${c.grievanceType.name}) was not resolved in ${hours} hours: ${c.title}`
      );
      await notify([c.complainantId, c.assignedToId], c.id, 'Complaint escalated',
        `${c.ticketNo} has been escalated to a higher authority`);
      result.escalated += 1;
    } else {
      // no higher authority is set: remind the current people
      const current = await findRecipients(c.grievanceTypeId, c.complainantId, c.currentLevel);
      await prisma.complaint.update({ where: { id: c.id }, data: { dueAt: newDue } });
      await prisma.statusHistory.create({
        data: {
          complaintId: c.id, status: c.status,
          note: `Escalation reminder: still not resolved after ${hours} hours, no higher authority set`,
        },
      });
      await notify(
        [...current, c.assignedToId], c.id, 'Complaint pending',
        `${c.ticketNo} is still not resolved after ${hours} hours: ${c.title}`
      );
      result.reminded += 1;
    }
  }

  console.log('[escalation]', JSON.stringify(result));
  return result;
}

module.exports = { runEscalation };
