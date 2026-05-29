const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- DATABASE CONNECTION ---
const mongoURI = process.env.MONGO_URI || "mongodb://localhost:27017/delivery_db";
mongoose.connect(mongoURI)
  .then(() => console.log('Successfully connected to MongoDB.'))
  .catch(err => console.error('MongoDB connection error:', err));

// --- MONGOOSE SCHEMAS ---
const DriverSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: String,
  vehicle: String,
  status: { type: String, enum: ['available', 'busy', 'offline'], default: 'offline' },
  isApproved: { type: Boolean, default: false }
});

const OrderSchema = new mongoose.Schema({
  customerName: { type: String, required: true },
  deliveryAddress: { type: String, required: true },
  itemDetails: { type: String, required: true },
  status: { type: String, enum: ['Pending', 'Assigned', 'Delivered'], default: 'Pending' },
  assignedDriver: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', default: null },
  createdAt: { type: Date, default: Date.now }
});

const Driver = mongoose.model('Driver', DriverSchema);
const Order = mongoose.model('Order', OrderSchema);

// --- MIDDLEWARE ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-key',
  resave: false,
  saveUninitialized: false
}));

// Auth Guard Middleware
const isAdmin = (req, res, next) => {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).send('<h1>401 Unauthorized</h1><p>Please log in via the admin portal.</p>');
};

// --- API ENDPOINTS ---

// Place an Order & Auto-Assign an Available Driver
app.post('/api/orders', async (req, res) => {
  try {
    const { customerName, deliveryAddress, itemDetails } = req.body;
    const availableDriver = await Driver.findOne({ status: 'available', isApproved: true });
    const orderData = { customerName, deliveryAddress, itemDetails };
    
    if (availableDriver) {
      orderData.status = 'Assigned';
      orderData.assignedDriver = availableDriver._id;
      availableDriver.status = 'busy';
      await availableDriver.save();
    }

    const newOrder = new Order(orderData);
    await newOrder.save();
    res.status(201).json({ success: true, order: newOrder, assigned: !!availableDriver });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Driver Application Endpoint
app.post('/api/drivers/apply', async (req, res) => {
  try {
    const { name, phone, vehicle } = req.body;
    const newDriver = new Driver({ name, phone, vehicle, status: 'offline', isApproved: false });
    await newDriver.save();
    res.status(201).json({ success: true, message: "Application submitted successfully!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Login Route
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const standardPassword = process.env.ADMIN_PASSWORD || 'admin123';
  if (password === standardPassword) {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Invalid Credentials' });
  }
});

app.get('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// --- ADMIN DASHBOARD PROTECTED API ---
app.get('/api/admin/data', isAdmin, async (req, res) => {
  try {
    const totalOrders = await Order.countDocuments();
    const activeDrivers = await Driver.countDocuments({ status: { $in: ['available', 'busy'] }, isApproved: true });
    const applicationsCount = await Driver.countDocuments({ isApproved: false });
    
    // Sort orders so pending/assigned show up first
    const orders = await Order.find().populate('assignedDriver').sort({ status: 1, createdAt: -1 });
    const drivers = await Driver.find({ isApproved: true });
    const applications = await Driver.find({ isApproved: false });

    res.json({ totalOrders, activeDrivers, applicationsCount, orders, drivers, applications });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Actions: Approve Driver
app.post('/api/admin/driver/:id/approve', isAdmin, async (req, res) => {
  await Driver.findByIdAndUpdate(req.params.id, { isApproved: true, status: 'available' });
  res.json({ success: true });
});

// Admin Actions: Toggle Driver Status Manual Override
app.post('/api/admin/driver/:id/toggle-status', isAdmin, async (req, res) => {
  const driver = await Driver.findById(req.params.id);
  driver.status = driver.status === 'offline' ? 'available' : 'offline';
  await driver.save();
  res.json({ success: true });
});

// NEW ADMIN ACTION: Complete Order & Free the Driver!
app.post('/api/admin/orders/:id/deliver', isAdmin, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (order.status === 'Assigned' && order.assignedDriver) {
      // Free the driver up!
      await Driver.findByIdAndUpdate(order.assignedDriver, { status: 'available' });
    }

    order.status = 'Delivered';
    await order.save();

    // Check if there are backlogged 'Pending' orders to auto-assign to this newly freed driver!
    const backloggedOrder = await Order.findOne({ status: 'Pending' }).sort({ createdAt: 1 });
    const freedDriver = await Driver.findOne({ status: 'available', isApproved: true });

    if (backloggedOrder && freedDriver) {
      backloggedOrder.status = 'Assigned';
      backloggedOrder.assignedDriver = freedDriver._id;
      await backloggedOrder.save();

      freedDriver.status = 'busy';
      await freedDriver.save();
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// --- FRONTEND HTML ---
const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RedDash | Instant Delivery Platform</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
</head>
<body class="bg-gray-50 font-sans text-gray-800 antialiased min-h-screen flex flex-col">

  <div class="flex flex-1 overflow-hidden">
    <!-- SIDEBAR -->
    <aside id="sidebar" class="w-64 bg-slate-900 text-white flex-shrink-0 hidden md:flex flex-col z-50 fixed md:relative h-full">
      <div class="p-5 bg-red-600 font-bold text-2xl flex items-center gap-3 tracking-wide">
        <i class="fa-solid fa-truck-fast"></i> RedDash
      </div>
      <nav class="flex-1 p-4 space-y-2 text-gray-300">
        <a href="#" onclick="showSection('home')" class="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-800 hover:text-white transition cursor-pointer"><i class="fa-solid fa-house"></i> Home</a>
        <a href="#" onclick="showSection('apply')" class="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-800 hover:text-white transition cursor-pointer"><i class="fa-solid fa-id-badge"></i> Join as Driver</a>
        <a href="#" onclick="showSection('admin')" class="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-800 hover:text-white transition cursor-pointer"><i class="fa-solid fa-lock"></i> Admin Dashboard</a>
      </nav>
      <div class="p-4 border-t border-gray-800 text-xs text-gray-500">© 2026 RedDash Inc.</div>
    </aside>

    <!-- Main Workspace Area -->
    <div class="flex-1 flex flex-col min-w-0 overflow-y-auto">
      <!-- MOBILE TOP BAR -->
      <header class="bg-white border-b p-4 flex items-center justify-between md:hidden shadow-sm">
        <span class="text-red-600 font-black text-xl tracking-tight"><i class="fa-solid fa-truck-fast"></i> RedDash</span>
        <button onclick="toggleSidebar()" class="text-gray-700 text-2xl focus:outline-none"><i class="fa-solid fa-bars"></i></button>
      </header>

      <main class="p-4 md:p-8 flex-1">
        <!-- SECTION 1: HOME PAGE -->
        <section id="home-section" class="space-y-12">
          <div class="bg-gradient-to-r from-red-600 to-red-700 rounded-3xl p-6 md:p-12 text-white shadow-xl flex flex-col md:flex-row items-center justify-between gap-8">
            <div class="max-w-xl space-y-4">
              <span class="bg-red-800/50 text-red-200 text-xs uppercase font-extrabold px-3 py-1 rounded-full tracking-widest">Lightning Fast Deliveries</span>
              <h1 class="text-4xl md:text-5xl font-black leading-tight">Hungry? Urgent Package? We Dispatch Instantly.</h1>
              <p class="text-red-100 text-base md:text-lg">Experience premium localized logistics. Place your request below and our system dynamically pairs you with active drivers immediately.</p>
            </div>
            <div class="text-6xl md:text-8xl text-red-200/20 opacity-80 hidden sm:block"><i class="fa-solid fa-truck-ramp-box"></i></div>
          </div>

          <div class="max-w-3xl mx-auto bg-white border border-gray-100 shadow-xl rounded-2xl p-6 md:p-8">
            <h2 class="text-2xl font-bold mb-2 flex items-center gap-2"><i class="fa-solid fa-circle-plus text-red-600"></i> Dispatch a New Request</h2>
            <p class="text-sm text-gray-500 mb-6">Enter details below to auto-assign the nearest functional courier.</p>
            <form id="orderForm" onsubmit="handleOrderSubmit(event)" class="space-y-4">
              <div>
                <label class="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-2">Your Full Name</label>
                <input type="text" id="orderName" required placeholder="John Doe" class="w-full px-4 py-3 border rounded-xl focus:ring-2 focus:ring-red-500 focus:outline-none">
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label class="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-2">Item Descriptions</label>
                  <input type="text" id="orderItem" required placeholder="Pepperoni Pizza / Office Docs" class="w-full px-4 py-3 border rounded-xl focus:ring-2 focus:ring-red-500 focus:outline-none">
                </div>
                <div>
                  <label class="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-2">Dropoff Address</label>
                  <input type="text" id="orderAddress" required placeholder="Apt 4B, 5th Avenue" class="w-full px-4 py-3 border rounded-xl focus:ring-2 focus:ring-red-500 focus:outline-none">
                </div>
              </div>
              <button type="submit" class="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-3 px-6 rounded-xl transition duration-200 shadow-md">Instantly Match Me with a Driver</button>
            </form>
          </div>
        </section>

        <!-- SECTION 2: APPLICATION FOR DRIVERS -->
        <section id="apply-section" class="hidden max-w-2xl mx-auto bg-white border shadow-xl rounded-2xl p-6 md:p-8">
          <div class="text-center mb-6">
            <div class="inline-block p-4 bg-red-50 text-red-600 rounded-full text-3xl mb-3"><i class="fa-solid fa-address-card"></i></div>
            <h2 class="text-3xl font-black">Become a Fleet Courier</h2>
            <p class="text-gray-500 text-sm mt-1">Submit your profile setup details. Once approved by our administrator, you can toggle active status online to take jobs.</p>
          </div>
          <form id="applyForm" onsubmit="handleApplicationSubmit(event)" class="space-y-4">
            <div>
              <label class="block text-xs font-bold text-gray-700 uppercase mb-1">Driver Full Name</label>
              <input type="text" id="driverName" required class="w-full px-4 py-3 border rounded-xl focus:ring-2 focus:ring-red-500 focus:outline-none">
            </div>
            <div>
              <label class="block text-xs font-bold text-gray-700 uppercase mb-1">Phone Line</label>
              <input type="tel" id="driverPhone" required class="w-full px-4 py-3 border rounded-xl focus:ring-2 focus:ring-red-500 focus:outline-none">
            </div>
            <div>
              <label class="block text-xs font-bold text-gray-700 uppercase mb-1">Vehicle Details & Model</label>
              <input type="text" id="driverVehicle" placeholder="E-Bike, Sports Sedan, Van" required class="w-full px-4 py-3 border rounded-xl focus:ring-2 focus:ring-red-500 focus:outline-none">
            </div>
            <button type="submit" class="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-3 px-6 rounded-xl transition duration-200">Submit Registry Application</button>
          </form>
        </section>

        <!-- SECTION 3: ADMIN CONSOLE -->
        <section id="admin-section" class="hidden space-y-8">
          <div id="adminAuthGate" class="max-w-md mx-auto bg-white border rounded-2xl shadow-xl p-6">
            <div class="text-center mb-4"><i class="fa-solid fa-shield-halved text-4xl text-red-600"></i></div>
            <h3 class="text-xl font-bold text-center mb-4">Internal Admin Verification</h3>
            <div class="space-y-3">
              <input type="password" id="adminPassInput" placeholder="Enter System Password" class="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500">
              <button onclick="attemptAdminLogin()" class="w-full bg-red-600 text-white py-2 rounded-lg font-bold hover:bg-red-700">Unlock Console</button>
            </div>
          </div>

          <div id="adminPanelContent" class="hidden space-y-6">
            <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b pb-4">
              <div>
                <h2 class="text-3xl font-black tracking-tight text-slate-900">Operations Control Center</h2>
                <p class="text-sm text-gray-500">Manage online trackers, incoming application pipelines, and dynamic assignments.</p>
              </div>
              <a href="/api/admin/logout" class="bg-gray-200 text-gray-700 px-4 py-2 rounded-lg text-xs font-bold hover:bg-gray-300">Lock Terminal Session</a>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div class="bg-white border p-5 rounded-xl shadow-sm flex items-center justify-between">
                <div><p class="text-xs font-bold text-gray-400 uppercase">Gross System Logs</p><h4 id="statOrders" class="text-3xl font-black text-slate-800">0</h4></div>
                <div class="text-2xl text-red-500 bg-red-50 p-3 rounded-lg"><i class="fa-solid fa-box"></i></div>
              </div>
              <div class="bg-white border p-5 rounded-xl shadow-sm flex items-center justify-between">
                <div><p class="text-xs font-bold text-gray-400 uppercase">Tracked Online Fleet</p><h4 id="statDrivers" class="text-3xl font-black text-slate-800">0</h4></div>
                <div class="text-2xl text-green-500 bg-green-50 p-3 rounded-lg"><i class="fa-solid fa-signal"></i></div>
              </div>
              <div class="bg-white border p-5 rounded-xl shadow-sm flex items-center justify-between">
                <div><p class="text-xs font-bold text-gray-400 uppercase">Pending Recruits</p><h4 id="statApps" class="text-3xl font-black text-slate-800">0</h4></div>
                <div class="text-2xl text-amber-500 bg-amber-50 p-3 rounded-lg"><i class="fa-solid fa-user-clock"></i></div>
              </div>
            </div>

            <div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <div class="space-y-6">
                <div class="bg-white border rounded-xl p-4 shadow-sm">
                  <h3 class="text-lg font-bold border-b pb-2 mb-3 text-red-600"><i class="fa-solid fa-id-card-clip"></i> Active Registries & Dispatch Status</h3>
                  <div class="overflow-x-auto"><table class="w-full text-left text-sm"><thead class="bg-gray-100 text-xs font-bold uppercase text-gray-600"><tr><th class="p-2">Name</th><th class="p-2">Vehicle</th><th class="p-2">Status Tracking</th><th class="p-2">Action</th></tr></thead><tbody id="driversTableBody"></tbody></table></div>
                </div>
                <div class="bg-white border rounded-xl p-4 shadow-sm">
                  <h3 class="text-lg font-bold border-b pb-2 mb-3 text-amber-600"><i class="fa-solid fa-envelope-open-text"></i> Open Application Pipelines</h3>
                  <div class="overflow-x-auto"><table class="w-full text-left text-sm"><thead class="bg-gray-100 text-xs font-bold uppercase text-gray-600"><tr><th class="p-2">Applicant</th><th class="p-2">Asset Details</th><th class="p-2">Command</th></tr></thead><tbody id="appsTableBody"></tbody></table></div>
                </div>
              </div>
              <div class="bg-white border rounded-xl p-4 shadow-sm">
                <h3 class="text-lg font-bold border-b pb-2 mb-3 text-slate-800"><i class="fa-solid fa-map-location-dot"></i> Live Operational Log Ledger</h3>
                <div class="overflow-x-auto"><table class="w-full text-left text-sm"><thead class="bg-gray-100 text-xs font-bold uppercase text-gray-600"><tr><th class="p-2">Client</th><th class="p-2">Parcel Data</th><th class="p-2">Tracking Node</th><th class="p-2">Action</th></tr></thead><tbody id="ordersTableBody"></tbody></table></div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  </div>

  <script>
    function toggleSidebar() {
      const sidebar = document.getElementById('sidebar');
      sidebar.classList.toggle('hidden');
    }

    // Fixed dynamic layout routing
    function showSection(sectionId) {
      document.getElementById('home-section').classList.add('hidden');
      document.getElementById('apply-section').classList.add('hidden');
      document.getElementById('admin-section').classList.add('hidden');
      document.getElementById(sectionId + '-section').classList.remove('hidden');
      if (window.innerWidth < 768) toggleSidebar();
      if(sectionId === 'admin' && localStorage.getItem('isAdminAuth') === 'true') {
        loadAdminDashboard();
      }
    }

    async function handleOrderSubmit(e) {
      e.preventDefault();
      const orderPayload = {
        customerName: document.getElementById('orderName').value,
        itemDetails: document.getElementById('orderItem').value,
        deliveryAddress: document.getElementById('orderAddress').value
      };
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(orderPayload)
      });
      const data = await res.json();
      if(data.success) {
        alert(data.assigned ? 'Fantastic! Order logged and driver dispatched instantly.' : 'Order pinned to backlog. No available drivers active right now.');
        document.getElementById('orderForm').reset();
      }
    }

    async function handleApplicationSubmit(e) {
      e.preventDefault();
      const driverPayload = {
        name: document.getElementById('driverName').value,
        phone: document.getElementById('driverPhone').value,
        vehicle: document.getElementById('driverVehicle').value
      };
      const res = await fetch('/api/drivers/apply', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(driverPayload)
      });
      const data = await res.json();
      if(data.success) {
        alert('Application submitted into verification staging logs safely.');
        document.getElementById('applyForm').reset();
        showSection('home');
      }
    }

    async function attemptAdminLogin() {
      const password = document.getElementById('adminPassInput').value;
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if(data.success) {
        localStorage.setItem('isAdminAuth', 'true');
        loadAdminDashboard();
      } else {
        alert('Authentication Rejected.');
      }
    }

    async function loadAdminDashboard() {
      const res = await fetch('/api/admin/data');
      if(res.status === 401) {
        localStorage.setItem('isAdminAuth', 'false');
        document.getElementById('adminAuthGate').classList.remove('hidden');
        document.getElementById('adminPanelContent').classList.add('hidden');
        return;
      }
      const data = await res.json();
      document.getElementById('adminAuthGate').classList.add('hidden');
      document.getElementById('adminPanelContent').classList.remove('hidden');

      document.getElementById('statOrders').innerText = data.totalOrders;
      document.getElementById('statDrivers').innerText = data.activeDrivers;
      document.getElementById('statApps').innerText = data.applicationsCount;

      const driversBody = document.getElementById('driversTableBody');
      driversBody.innerHTML = data.drivers.map(d => {
        return \`
          <tr class="border-b">
            <td class="p-2 font-medium">\${d.name}</td>
            <td class="p-2 text-gray-500 text-xs">\${d.vehicle}</td>
            <td class="p-2">
              <span class="px-2 py-0.5 rounded-full text-xs font-bold \${d.status === 'available' ? 'bg-green-100 text-green-700' : d.status === 'busy' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}">
                \${d.status}
              </span>
            </td>
            <td class="p-2">
              <button onclick="toggleDriverStatus('\${d._id}')" class="text-xs bg-slate-100 border px-2 py-1 rounded hover:bg-slate-200">Simulate Toggle</button>
            </td>
          </tr>
        \`;
      }).join('');

      const appsBody = document.getElementById('appsTableBody');
      appsBody.innerHTML = data.applications.length ? data.applications.map(a => {
        return \`
          <tr class="border-b">
            <td class="p-2 font-bold text-gray-700">\${a.name} <p class="text-xs text-gray-400 font-normal">\${a.phone}</p></td>
            <td class="p-2 text-xs">\${a.vehicle}</td>
            <td class="p-2"><button onclick="approveDriver('\${a._id}')" class="bg-red-600 text-white text-xs px-2 py-1 rounded font-bold hover:bg-red-700">Approve</button></td>
          </tr>
        \`;
      }).join('') : '<tr><td colspan="3" class="p-3 text-center text-xs text-gray-400">No open applications in current pipeline.</td></tr>';

      const ordersBody = document.getElementById('ordersTableBody');
      ordersBody.innerHTML = data.orders.map(o => {
        const driverName = o.assignedDriver ? '⚡ ' + o.assignedDriver.name : '⚠️ Awaiting Fleet Availability';
        
        // Dynamic action button to resolve orders and clear driver queues
        let actionButton = '';
        if (o.status !== 'Delivered') {
          actionButton = \`<button onclick="markAsDelivered('\${o._id}')" class="bg-slate-900 text-white text-[10px] px-2 py-1 rounded font-bold hover:bg-red-600 transition">Complete</button>\`;
        } else {
          actionButton = \`<span class="text-green-600 font-bold text-xs"><i class="fa-solid fa-circle-check"></i> Done</span>\`;
        }

        return \`
          <tr class="border-b text-xs">
            <td class="p-2 font-semibold text-slate-800">\${o.customerName}<p class="text-gray-400 text-[10px] font-normal">\${o.deliveryAddress}</p></td>
            <td class="p-2 text-gray-600 italic">"\${o.itemDetails}"</td>
            <td class="p-2">
              <span class="block font-bold text-slate-700">\${o.status}</span>
              <span class="text-[10px] text-gray-500">\${driverName}</span>
            </td>
            <td class="p-2">
              \${actionButton}
            </td>
          </tr>
        \`;
      }).join('');
    }

    async function approveDriver(id) {
      await fetch('/api/admin/driver/' + id + '/approve', { method: 'POST' });
      loadAdminDashboard();
    }

    async function toggleDriverStatus(id) {
      await fetch('/api/admin/driver/' + id + '/toggle-status', { method: 'POST' });
      loadAdminDashboard();
    }

    // Call the resolution API routing point
    async function markAsDelivered(orderId) {
      const res = await fetch('/api/admin/orders/' + orderId + '/deliver', { method: 'POST' });
      if (res.ok) {
        loadAdminDashboard();
      }
    }
  </script>
</body>
</html>
`;

app.get('/', (req, res) => {
  res.send(htmlContent);
});

app.listen(PORT, () => console.log(`RedDash system executing processes smoothly on port: ${PORT}`));