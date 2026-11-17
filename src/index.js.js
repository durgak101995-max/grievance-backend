require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const complaintRoutes = require('./routes/complaints');
const notificationRoutes = require('./routes/notifications');
const { runEscalation } = require('./escalation');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'Grievance API running' }));
app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
app.use('/complaints', complaintRoutes);
app.use('/notifications', notificationRoutes);

// Called by a free cron service every few minutes (also keeps the server awake).
// GET /cron/escalate?key=YOUR_CRON_KEY   (optional: &hours=0 for testing)
app.get('/cron/escalate', async (req, res) => {
  if (!process.env.CRON_KEY || req.query.key !== process.env.CRON_KEY) {
    return res.status(403).json({ message: 'Invalid key' });
  }
  try {
    res.json(await runEscalation(req.query.hours));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Escalation failed' });
  }
});

// Backup: also check every 10 minutes while the server is awake
setInterval(() => runEscalation().catch((e) => console.error(e)), 10 * 60 * 1000);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
