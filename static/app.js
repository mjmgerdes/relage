'use strict';

let state = null;
let profile = null;
let config = null;
let currentView = 'home';
let userPinned = false;
let lastStatus = '';
let localBubbles = [];
let drawerReturnFocus = null;
let toastTimer = null;

const HUMAN_STATUS = {
  NEEDS_APPOINTMENT: 'Ready to coordinate your care',
  APPOINTMENT_HELD: 'Holding a morning appointment',
  TRANSPORT_NEEDED: 'Arranging the ride',
  CAREGIVER_CONTACTED: 'Waiting for the caregiver reply',
  CAREGIVER_UNAVAILABLE: 'Finding an accessible ride',
  TRANSPORT_FOUND: 'Finishing the plan',
  AWAITING_USER_CONFIRMATION: 'Your plan is ready',
  CONFIRMED: 'Appointment and ride confirmed'
};

const JOURNEY_SUMMARY = {
  NEEDS_APPOINTMENT: 'Ready to start',
  APPOINTMENT_HELD: 'Appointment held',
  TRANSPORT_NEEDED: 'Appointment held',
  CAREGIVER_CONTACTED: 'Caregiver contacted',
  CAREGIVER_UNAVAILABLE: 'Finding another ride',
  TRANSPORT_FOUND: 'Ride found',
  AWAITING_USER_CONFIRMATION: 'Waiting for your approval',
  CONFIRMED: 'Complete'
};

const ICONS = {
  appointment: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 20h16M6 20V8h12v12M9 8V4h6v4M9 12h2M13 12h2M9 16h2M13 16h2"/></svg>',
  ride: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 16V9l2-4h14l2 4v7M5 16h14M6 12h2M16 12h2M5 16v3M19 16v3"/></svg>',
  reminder: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>',
  arrow: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
  phone: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.2 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.68 2.78a2 2 0 0 1-.45 2.11L8.07 9.88a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.89.32 1.82.55 2.78.68A2 2 0 0 1 22 16.92Z"/></svg>',
  calendar: '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>',
  check: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>',
  future: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="9"/></svg>'
};

function esc(value) {
  return String(value == null ? '' : value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function val(id) {
  return document.getElementById(id).value;
}

function showToast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.hidden = true; }, 4200);
}

function showView(name, pinned) {
  if (pinned === undefined) pinned = true;
  const next = document.getElementById('view-' + name);
  if (!next) return;
  currentView = name;
  userPinned = pinned;
  document.querySelectorAll('.view').forEach(function (view) {
    view.classList.toggle('active', view === next);
  });
  const homeNav = document.getElementById('nav-home');
  const scheduleNav = document.getElementById('nav-schedule');
  homeNav.classList.toggle('active', name === 'home');
  scheduleNav.classList.toggle('active', name === 'schedule');
  homeNav.toggleAttribute('aria-current', name === 'home');
  scheduleNav.toggleAttribute('aria-current', name === 'schedule');
  if (name === 'schedule') refreshCalendar();
  if (name === 'setup') populateProfileForm();
  const heading = next.querySelector('h1');
  if (heading) requestAnimationFrame(function () { heading.focus({ preventScroll: true }); });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleDrawer(forceOpen) {
  const drawer = document.getElementById('drawer');
  const scrim = document.getElementById('drawerScrim');
  const shouldOpen = forceOpen === undefined ? !drawer.classList.contains('open') : forceOpen;
  if (shouldOpen) {
    drawerReturnFocus = document.activeElement;
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    scrim.hidden = false;
    document.body.style.overflow = 'hidden';
    document.getElementById('drawerClose').focus();
  } else {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    scrim.hidden = true;
    document.body.style.overflow = '';
    if (drawerReturnFocus && drawerReturnFocus.focus) drawerReturnFocus.focus();
  }
}

document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape' && document.getElementById('drawer').classList.contains('open')) {
    toggleDrawer(false);
  }
});

async function startCoordinate() {
  const button = document.getElementById('goBtn');
  button.disabled = true;
  button.textContent = 'Starting your care plan...';
  showView('working', false);
  try {
    const response = await fetch('/coordinate', { method: 'POST' });
    if (!response.ok) throw new Error('Could not start coordination');
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Coordinate my visit';
    showView('home', false);
    showToast('Relage could not start. Check the server and try again.');
  }
}

async function confirmPlan() {
  const button = document.getElementById('confirmBtn');
  button.disabled = true;
  button.textContent = 'Booking your plan...';
  try {
    const response = await fetch('/confirm-plan', { method: 'POST' });
    if (!response.ok) throw new Error('Could not confirm plan');
    userPinned = false;
    await refreshCalendar();
    await poll(true);
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Confirm and book';
    showToast('Relage could not book the plan. Try again.');
  }
}

async function resetDemo() {
  try {
    await fetch('/reset', { method: 'POST' });
    localBubbles = [];
    lastStatus = '';
    const goButton = document.getElementById('goBtn');
    goButton.disabled = false;
    goButton.innerHTML = 'Coordinate my visit' + ICONS.arrow;
    await loadProfile();
    await poll(true);
    showView('home', false);
    toggleDrawer(false);
    showToast('Demo reset. Eleanor’s care task is ready.');
  } catch (error) {
    showToast('Relage could not reset the demo.');
  }
}

async function sendSms() {
  const input = document.getElementById('smsInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  localBubbles.push({
    dir: 'out',
    text: text,
    who: cgFirst(),
    afterInbound: (state && state.sms_outbox ? state.sms_outbox : []).length
  });
  renderPhone();
  try {
    const response = await fetch('/caregiver-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text })
    });
    if (!response.ok) throw new Error('No caregiver request is waiting');
  } catch (error) {
    showToast('Start the care journey before sending a caregiver reply.');
  }
}

function quick(text) {
  document.getElementById('smsInput').value = text;
  sendSms();
}

async function callCaregiver() {
  const button = document.getElementById('callBtn');
  button.disabled = true;
  button.textContent = 'Calling caregiver...';
  try {
    const response = await fetch('/call-caregiver', { method: 'POST' });
    if (!response.ok) throw new Error('Call failed');
    button.textContent = 'Phone ringing. Answer and speak.';
  } catch (error) {
    button.textContent = 'Call failed. Check phone setup.';
  }
  setTimeout(function () {
    button.disabled = false;
    button.innerHTML = ICONS.phone + ' Call caregiver’s phone';
  }, 15000);
}

function cgFirst() {
  return ((profile && profile.caregiver && profile.caregiver.name) || 'Caregiver').split(' ')[0];
}

function patientFirst() {
  return ((profile && profile.patient && profile.patient.name) || 'Eleanor').split(' ')[0];
}

function renderPhone() {
  const el = document.getElementById('phoneMsgs');
  const outbox = state && state.sms_outbox ? state.sms_outbox : [];
  const inbound = outbox.map(function (message) {
    let route = 'Relage to ' + message.to;
    if (message.via === 'twilio') route += ' · sent by SMS';
    if (message.via === 'voice') route += ' · phone call';
    return { dir: 'in', text: message.body, who: route };
  });
  const all = inbound.slice();
  localBubbles.slice().reverse().forEach(function (bubble) {
    all.splice(bubble.afterInbound, 0, bubble);
  });
  if (!all.length) {
    el.innerHTML = '<div class="empty-message">Start the care journey to contact ' + esc(cgFirst()) + '.</div>';
    return;
  }
  el.innerHTML = all.map(function (bubble) {
    return '<div class="bubble ' + esc(bubble.dir) + '"><div class="who">' + esc(bubble.who) + '</div>' + esc(bubble.text) + '</div>';
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function renderWorking() {
  if (!state) return;
  const items = (state.activity || []).filter(function (item) { return item.friendly; });
  const el = document.getElementById('friendlySteps');
  const waiting = state.status === 'CAREGIVER_CONTACTED';
  document.getElementById('workTitle').textContent = waiting
    ? 'Waiting for ' + cgFirst() + ' to answer.'
    : 'Arranging your appointment and ride.';
  document.getElementById('workSub').textContent = waiting
    ? 'Relage asked about the ride. If ' + cgFirst() + ' cannot help, Relage will find an accessible option.'
    : 'You can leave this screen open. Relage will stop when it needs your approval.';
  if (!items.length) {
    el.innerHTML = '<div class="empty-progress">Starting the on-device care planner...</div>';
    return;
  }
  el.innerHTML = items.map(function (item, index) {
    const isLast = index === items.length - 1;
    const isCurrent = isLast && (state.busy || waiting);
    const marker = isCurrent ? '<span class="spinner"></span>' : '✓';
    return '<div class="step' + (isCurrent ? ' current' : '') + '"><span class="step-icon">' + marker + '</span><span>' + esc(item.friendly) + '</span></div>';
  }).join('');
}

function planRowsHtml() {
  if (!state || !state.appointment || !state.transport) return '';
  const appointment = state.appointment;
  const transport = state.transport;
  const care = profile && profile.recurring_care && profile.recurring_care[0]
    ? profile.recurring_care[0].type : 'appointment';
  const rideHome = transport.return_pickup_time === 'after appointment'
    ? 'Ride home after the visit'
    : 'Return pickup at ' + transport.return_pickup_time;
  return '<div class="planrow"><span class="row-icon">' + ICONS.appointment + '</span><div>' +
      '<b>' + esc(titleCase(care)) + '</b>' +
      '<div class="det">' + esc(appointment.provider) + '<br>' + esc(appointment.day) + ', ' + esc(fmtLong(appointment.date)) + ' at ' + esc(appointment.time) + '</div></div></div>' +
    '<div class="planrow"><span class="row-icon">' + ICONS.ride + '</span><div>' +
      '<b>' + esc(transport.name) + '</b>' +
      '<div class="det">Pickup at ' + esc(transport.pickup_time) + ' · Walker accessible<br>' + esc(rideHome) + '</div></div></div>' +
    '<div class="planrow"><span class="row-icon">' + ICONS.reminder + '</span><div>' +
      '<b>Reminders for both of you</b>' +
      '<div class="det">You and ' + esc(cgFirst()) + ' get an update the day before and the morning of the visit.</div></div></div>';
}

function stepsRecapHtml() {
  return ((state && state.activity) || []).filter(function (item) { return item.friendly; }).map(function (item) {
    return '<div class="step"><span class="step-icon">✓</span><span>' + esc(item.friendly) + '</span></div>';
  }).join('');
}

function renderDateBadge(date) {
  if (!date) return;
  const value = new Date(date + 'T12:00:00');
  document.getElementById('planDateBadge').innerHTML =
    '<span>' + value.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase() + '</span>' +
    '<strong>' + value.getDate() + '</strong>' +
    '<small>' + value.toLocaleDateString('en-US', { month: 'short' }).toUpperCase() + '</small>';
  document.getElementById('doneDate').textContent = value.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function renderReview() {
  if (!state || !state.appointment || !state.transport) return;
  document.getElementById('stepsReview').innerHTML = stepsRecapHtml();
  document.getElementById('planRows').innerHTML = planRowsHtml();
  renderDateBadge(state.appointment.date);
  const whyBox = document.getElementById('whyBox');
  if (state.plan_explanation) {
    whyBox.hidden = false;
    document.getElementById('whyText').textContent = state.plan_explanation;
  } else {
    whyBox.hidden = true;
  }
  const button = document.getElementById('confirmBtn');
  button.disabled = false;
  button.innerHTML = 'Confirm and book' + ICONS.check;
}

function renderDone() {
  if (!state || !state.appointment || !state.transport) return;
  document.getElementById('doneGreet').textContent = 'Your visit is set, ' + patientFirst() + '.';
  document.getElementById('doneRows').innerHTML = planRowsHtml();
  document.getElementById('stepsDone').innerHTML = stepsRecapHtml();
  document.getElementById('doneNote').textContent = 'We sent confirmations to you and ' + cgFirst() + '.';
  renderDateBadge(state.appointment.date);
}

async function refreshCalendar() {
  try {
    const response = await fetch('/calendar');
    const data = await response.json();
    const events = data.events || [];
    const el = document.getElementById('timeline');
    if (!events.length) {
      el.innerHTML = '<div class="empty-progress">No care events yet.</div>';
      return;
    }
    el.innerHTML = events.map(function (event) {
      const icon = event.kind === 'past' ? ICONS.check : event.kind === 'future' ? ICONS.future : event.kind === 'transport' ? ICONS.ride : ICONS.calendar;
      const timeTitle = event.time ? '<b>' + esc(event.time) + '</b><br>' : '';
      return '<div class="ev ' + esc(event.kind) + '">' +
        '<div class="date">' + esc(fmtShort(event.date)) + '</div>' +
        '<span class="timeline-dot">' + icon + '</span>' +
        '<div>' + timeTitle + '<span>' + esc(event.title) + '</span><div class="meta">' + esc(event.status) + '</div></div></div>';
    }).join('');
  } catch (error) {
    document.getElementById('timeline').innerHTML = '<div class="empty-progress">The schedule could not load.</div>';
  }
}

function fmtShort(date) {
  const value = new Date(date + 'T12:00:00');
  return value.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
}

function fmtLong(date) {
  const value = new Date(date + 'T12:00:00');
  return value.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

function titleCase(text) {
  return String(text || '').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
}

function renderHome() {
  if (!profile || !profile.patient) return;
  const first = patientFirst();
  const hour = new Date().getHours();
  const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  document.getElementById('homeTitle').textContent = 'Good ' + part + ', ' + first + '.';
  const due = state && state.status === 'NEEDS_APPOINTMENT';
  document.getElementById('needCard').hidden = !due;
  document.getElementById('allSet').hidden = due;
  document.getElementById('homeLead').textContent = due
    ? 'One care task needs your attention.'
    : 'Your current care tasks are handled.';
  if (due && profile.recurring_care && profile.recurring_care[0]) {
    const care = profile.recurring_care[0];
    document.getElementById('needTitle').textContent = titleCase(care.type).replaceAll('-', '‑');
    document.getElementById('careInterval').textContent = 'Every ' + care.interval_months + ' months';
    document.getElementById('needBody').textContent = 'Your recurring care plan says it is time to schedule the next visit with ' + care.provider + '.';
  }
  renderPreferences();
}

function renderPreferences() {
  if (!profile || !profile.patient) return;
  const patient = profile.patient;
  const time = (patient.preferred_times && patient.preferred_times[0]) || 'Flexible timing';
  const mobility = patient.mobility_needs && patient.mobility_needs.length
    ? titleCase(patient.mobility_needs.join(', ')) + ' access'
    : 'No mobility aid';
  document.getElementById('preferenceList').innerHTML =
    '<div><span class="preference-icon" aria-hidden="true">AM</span><span><strong>' + esc(titleCase(time)) + '</strong><small>Your preferred time</small></span></div>' +
    '<div><span class="preference-icon" aria-hidden="true">M</span><span><strong>' + esc(patient.insurance) + '</strong><small>In-network providers</small></span></div>' +
    '<div><span class="preference-icon" aria-hidden="true">W</span><span><strong>' + esc(mobility) + '</strong><small>Transport requirement</small></span></div>';
}

function populateProfileForm() {
  if (!profile || !profile.patient) return;
  const names = profile.patient.name.split(' ');
  document.getElementById('f_first').value = names.shift() || '';
  document.getElementById('f_last').value = names.join(' ');
  document.getElementById('f_age').value = profile.patient.age || '';
  document.getElementById('f_town').value = profile.patient.home_location || '';
  document.getElementById('f_ins').value = profile.patient.insurance || 'Medicare';
  document.getElementById('f_pharm').value = profile.patient.preferred_pharmacy || '';
  const mobility = profile.patient.mobility_needs || [];
  document.getElementById('f_walker').checked = mobility.includes('walker');
  document.getElementById('f_wheel').checked = mobility.includes('wheelchair');
  document.getElementById('f_none').checked = mobility.length === 0;
  document.getElementById('f_time').value = (profile.patient.preferred_times && profile.patient.preferred_times[0]) || 'weekday mornings';
  if (profile.caregiver) {
    document.getElementById('f_cgname').value = profile.caregiver.name || '';
    document.getElementById('f_cgphone').value = profile.caregiver.phone || '';
  }
  const care = profile.recurring_care && profile.recurring_care[0];
  if (care) {
    document.getElementById('f_care').value = care.type || '';
    document.getElementById('f_prov').value = care.provider || '';
    document.getElementById('f_interval').value = care.interval_months || 6;
    document.getElementById('f_last_visit').value = care.last_visit || '';
  }
}

async function saveProfile() {
  const mobility = [];
  if (document.getElementById('f_walker').checked) mobility.push('walker');
  if (document.getElementById('f_wheel').checked) mobility.push('wheelchair');
  const body = {
    patient: {
      name: (val('f_first') + ' ' + val('f_last')).trim(),
      age: parseInt(val('f_age'), 10) || 0,
      home_location: val('f_town'),
      insurance: val('f_ins'),
      mobility_needs: mobility,
      preferred_times: [val('f_time')],
      preferred_pharmacy: val('f_pharm')
    },
    caregiver: {
      name: val('f_cgname'),
      relationship: (profile && profile.caregiver && profile.caregiver.relationship) || 'caregiver',
      phone: val('f_cgphone')
    },
    recurring_care: [{
      type: val('f_care'),
      provider: val('f_prov'),
      interval_months: parseInt(val('f_interval'), 10) || 6,
      last_visit: val('f_last_visit'),
      source: 'caregiver-entered recurring plan'
    }]
  };
  const button = document.getElementById('saveBtn');
  button.disabled = true;
  button.textContent = 'Saving care profile...';
  try {
    const response = await fetch('/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error('Profile save failed');
    profile = await response.json();
    localBubbles = [];
    lastStatus = '';
    document.getElementById('saveNote').hidden = false;
    renderHome();
    renderDemoIdentity();
    setTimeout(function () { document.getElementById('saveNote').hidden = true; }, 4200);
  } catch (error) {
    showToast('Relage could not save the profile.');
  } finally {
    button.disabled = false;
    button.textContent = 'Save care profile';
  }
}

async function sendOnboard() {
  const input = document.getElementById('onboardInput');
  const text = input.value.trim();
  if (!text) return;
  const button = document.getElementById('onboardBtn');
  button.disabled = true;
  button.textContent = 'Gemma is reading...';
  try {
    const response = await fetch('/onboarding-note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text })
    });
    if (!response.ok) throw new Error('Preference failed');
    const out = await response.json();
    const preferences = (out.preferences || []).map(function (item) {
      return '<span>' + esc(titleCase(String(item.field || '').replaceAll('_', ' '))) + ': ' + esc(item.value) + '</span>';
    }).join(' · ');
    document.getElementById('onboardOut').hidden = false;
    document.getElementById('onboardText').innerHTML = esc(out.summary || 'Preference added.') + (preferences ? '<br><small>' + preferences + '</small>' : '');
    input.value = '';
  } catch (error) {
    showToast('Relage could not interpret that preference. Try again.');
  } finally {
    button.disabled = false;
    button.textContent = 'Add preference';
  }
}

function renderTech() {
  const el = document.getElementById('techFeed');
  const items = (state && state.activity) || [];
  if (!items.length) {
    el.innerHTML = '<div class="empty-feed">Agent decisions will appear here.</div>';
    return;
  }
  el.innerHTML = items.map(function (item) {
    return '<div class="tf kind-' + esc(item.kind) + '"><span class="k">' + esc(item.kind) + '</span>' + esc(item.text) + '</div>';
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function renderJourney() {
  if (!state) return;
  const stages = {
    NEEDS_APPOINTMENT: 0,
    APPOINTMENT_HELD: 1,
    TRANSPORT_NEEDED: 1,
    CAREGIVER_CONTACTED: 2,
    CAREGIVER_UNAVAILABLE: 2,
    TRANSPORT_FOUND: 2,
    AWAITING_USER_CONFIRMATION: 3,
    CONFIRMED: 4
  };
  const current = stages[state.status] == null ? 0 : stages[state.status];
  document.querySelectorAll('#journey li').forEach(function (item, index) {
    item.classList.toggle('complete', index < current || current === 4);
    item.classList.toggle('current', index === current && current < 4);
    if (index === current && current < 4) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
  document.getElementById('journeySummary').textContent = JOURNEY_SUMMARY[state.status] || 'In progress';
}

function renderDemoIdentity() {
  const first = cgFirst();
  document.getElementById('caregiverName').textContent = first;
  document.getElementById('caregiverInitial').textContent = first.charAt(0).toUpperCase();
}

async function poll(immediate) {
  try {
    const response = await fetch('/state');
    state = await response.json();
    document.getElementById('statusHuman').textContent = HUMAN_STATUS[state.status] || 'Care coordination in progress';
    renderJourney();
    renderPhone();
    renderTech();
    renderDemoIdentity();
    const callButton = document.getElementById('callBtn');
    callButton.hidden = !(state.status === 'CAREGIVER_CONTACTED' && config && config.voice);
    if (state.status !== lastStatus) {
      lastStatus = state.status;
      if (currentView !== 'schedule' && currentView !== 'setup') userPinned = false;
    }
    if (!userPinned) {
      if (state.status === 'NEEDS_APPOINTMENT') {
        renderHome();
        if (currentView !== 'home') showView('home', false);
      } else if (state.status === 'AWAITING_USER_CONFIRMATION') {
        renderReview();
        if (currentView !== 'review') showView('review', false);
      } else if (state.status === 'CONFIRMED') {
        renderDone();
        if (currentView !== 'done') showView('done', false);
      } else {
        renderWorking();
        if (currentView !== 'working') showView('working', false);
      }
    } else if (currentView === 'working') {
      renderWorking();
    }
    renderHome();
  } catch (error) {
    if (immediate) showToast('Waiting for the Relage server...');
  }
  if (!immediate) setTimeout(poll, 1100);
}

async function loadProfile() {
  const response = await fetch('/profile');
  profile = await response.json();
  renderHome();
  renderDemoIdentity();
  populateProfileForm();
}

async function loadConfig() {
  try {
    const response = await fetch('/config');
    config = await response.json();
    const status = document.getElementById('twStatus');
    if (config.voice) status.textContent = 'Live voice';
    else if (config.twilio) status.textContent = 'Live SMS';
    else status.textContent = 'Simulator';
  } catch (error) {
    config = { twilio: false, voice: false };
  }
}

async function boot() {
  try {
    await Promise.all([loadProfile(), loadConfig(), refreshCalendar()]);
  } catch (error) {
    showToast('Relage is waiting for the server.');
  }
  poll(false);
}

boot();
