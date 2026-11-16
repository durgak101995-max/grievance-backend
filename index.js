require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const complaintRoutes = require('./routes/complaints');
const notificationRoutes = require('./routes/notifications');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'Grievance API running' }));
app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
app.use('/complaints', complaintRoutes);
app.use('/notifications', notificationRoutes);

// Next steps: escalation job, FCM push, reports

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
