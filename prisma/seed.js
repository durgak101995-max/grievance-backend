require('dotenv').config();
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const hash = await bcrypt.hash('password123', 10);

  const cse = await prisma.department.upsert({
    where: { name: 'CSE' }, update: {}, create: { name: 'CSE' },
  });

  await prisma.user.upsert({
    where: { loginId: 'ADMIN001' }, update: {},
    create: { loginId: 'ADMIN001', name: 'System Admin', role: 'ADMIN',
              email: 'admin@example.com', passwordHash: hash },
  });

  const hod = await prisma.user.upsert({
    where: { loginId: 'EMP1001' }, update: {},
    create: { loginId: 'EMP1001', name: 'CSE HOD', role: 'STAFF',
              email: 'hod.cse@example.com', passwordHash: hash, departmentId: cse.id },
  });

  await prisma.department.update({ where: { id: cse.id }, data: { hodId: hod.id } });

  await prisma.user.upsert({
    where: { loginId: 'EMP1002' }, update: {},
    create: { loginId: 'EMP1002', name: 'Hostel Warden', role: 'STAFF',
              email: 'warden@example.com', passwordHash: hash },
  });

  await prisma.user.upsert({
    where: { loginId: '21CS001' }, update: {},
    create: { loginId: '21CS001', name: 'Test Student', role: 'STUDENT',
              email: 'student@example.com', passwordHash: hash, departmentId: cse.id },
  });

  console.log('Seeded. Logins: ADMIN001 / EMP1001 / EMP1002 / 21CS001, password: password123');
}

main().catch(console.error).finally(() => prisma.$disconnect());
