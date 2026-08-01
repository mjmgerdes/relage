'use strict';

let state = null;
let profile = null;
let config = null;
let currentView = 'setup';
let userPinned = true;
let lastStatus = 'NEEDS_APPOINTMENT';
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
  document.getElementById('main').classList.toggle('setup-mode', name === 'setup');
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
  if (name === 'setup') {
    populateProfileForm();
    requestAnimationFrame(initRevealAnimations);
  }
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

async function startCoordinate(index, button) {
  if (index === undefined) index = 0;
  if (!button) button = document.querySelector('[data-coordinate-index="' + index + '"]');
  button.disabled = true;
  button.textContent = 'Starting your care plan...';
  // Pin the working view so the next poll tick (which may still see
  // NEEDS_APPOINTMENT) can't bounce back to home; the first real status
  // change unpins automatically.
  resetStepReveal();
  showView('working', true);
  renderWorking();
  try {
    const response = await fetch('/coordinate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: index })
    });
    if (!response.ok) throw new Error('Could not start coordination');
  } catch (error) {
    button.disabled = false;
    button.innerHTML = 'Coordinate this visit' + ICONS.arrow;
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
    resetStepReveal();
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

function sourceChips(item) {
  const sources = item && Array.isArray(item.sources) ? item.sources : [];
  if (!sources.length) return '';
  const chips = sources.map(function (source) {
    const rawUrl = String(source.url || '');
    const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : '#';
    return '<a class="source-chip" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer"' +
      ' aria-label="Open source: ' + esc(source.label || 'Source') + '"><span>' + esc(source.label || 'Source') + '</span> ↗</a>';
  }).join('');
  return '<span class="source-chips" aria-label="Sources consulted">' + chips + '</span>';
}

/* Sequential step reveal: backend activity arrives in bursts, but each step
   should appear one at a time — spinning while "fetching", then checking off
   as the next lands — so the agent visibly works. */
let stepsRevealed = 0;
let stepRevealTimer = null;
let lastStepsKey = '';

function resetStepReveal() {
  stepsRevealed = 0;
  lastStepsKey = '';
  if (stepRevealTimer) {
    clearTimeout(stepRevealTimer);
    stepRevealTimer = null;
  }
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
    ? ((config && config.voice)
      ? 'Relage is calling ' + cgFirst() + '. If the call reaches voicemail, Relage will try again.'
      : 'Relage sent the ride details to ' + cgFirst() + '. If she cannot help, Relage will find an accessible option.')
    : 'Relage pauses before booking anything.';
  if (items.length < stepsRevealed) resetStepReveal();
  if (items.length && !stepsRevealed) stepsRevealed = 1;
  if (items.length > stepsRevealed && !stepRevealTimer) {
    stepRevealTimer = setTimeout(function () {
      stepRevealTimer = null;
      stepsRevealed += 1;
      renderWorking();
    }, 700);
  }
  if (!items.length) {
    if (lastStepsKey !== 'empty') {
      el.innerHTML = '<div class="empty-progress">Starting coordination...</div>';
      lastStepsKey = 'empty';
    }
    return;
  }
  const visible = items.slice(0, stepsRevealed);
  const pending = items.length > stepsRevealed;
  const key = stepsRevealed + ':' + items.length + ':' + state.busy + ':' + waiting;
  if (key === lastStepsKey) return;
  lastStepsKey = key;
  el.innerHTML = visible.map(function (item, index) {
    const isLast = index === visible.length - 1;
    const isCurrent = isLast && (pending || state.busy || waiting);
    const marker = isCurrent ? '<span class="spinner"></span>' : '✓';
    return '<div class="step' + (isCurrent ? ' current' : '') + '"><span class="step-icon">' + marker + '</span><span>' + esc(item.friendly) + sourceChips(item) + '</span></div>';
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function planRowsHtml() {
  if (!state || !state.appointment || !state.transport) return '';
  const appointment = state.appointment;
  const transport = state.transport;
  const care = appointment.care_type || (profile && profile.recurring_care && profile.recurring_care[0]
    ? profile.recurring_care[0].type : 'appointment');
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
    return '<div class="step"><span class="step-icon">✓</span><span>' + esc(item.friendly) + sourceChips(item) + '</span></div>';
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

function monthsSince(dateString) {
  if (!dateString) return 999;
  const date = new Date(dateString + 'T12:00:00');
  const now = new Date();
  return (now.getFullYear() - date.getFullYear()) * 12 + now.getMonth() - date.getMonth();
}

function nextDueDate(care) {
  const date = new Date((care.last_visit || '2026-01-01') + 'T12:00:00');
  date.setMonth(date.getMonth() + (care.interval_months || 6));
  return date;
}

function careActionCard(care, index) {
  const address = care.address ? '<br><small>' + esc(care.address) + '</small>' : '';
  const mobility = profile.patient.mobility_needs && profile.patient.mobility_needs.length
    ? 'A ride that supports your ' + esc(profile.patient.mobility_needs[0])
    : 'A door-to-door ride';
  return '<article class="action-card" data-reveal>' +
    '<div class="card-kicker"><span class="status-badge"><span aria-hidden="true"></span> Time to schedule</span>' +
    '<span>Every ' + esc(care.interval_months || 6) + ' months</span></div>' +
    '<div class="care-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 21s-7-4.35-7-11a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 6.65-7 11-7 11Z"/><path d="M8.5 12h2l1-2.2 1.5 4.4 1-2.2h1.5"/></svg></div>' +
    '<h2>' + esc(titleCase(care.type).replaceAll('-', '‑')) + '</h2>' +
    '<p>This visit is due. Relage will check ' + esc(care.provider) + ' first.' + address + '</p>' +
    '<ul class="promise-list" aria-label="What Relage will arrange">' +
      '<li><span class="check-icon" aria-hidden="true">✓</span><span>In-network, ' + esc((profile.patient.preferred_times && profile.patient.preferred_times[0]) || 'flexible timing') + '</span></li>' +
      '<li><span class="check-icon" aria-hidden="true">✓</span><span>' + mobility + '</span></li>' +
    '</ul>' +
    '<button class="primary-button" type="button" data-coordinate-index="' + index + '" onclick="startCoordinate(' + index + ', this)">Coordinate this visit' + ICONS.arrow + '</button>' +
    '<p class="consent-note"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>Nothing is booked until you confirm.</p>' +
  '</article>';
}

function renderHome() {
  if (!profile || !profile.patient) return;
  const first = patientFirst();
  const hour = new Date().getHours();
  const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  document.getElementById('homeTitle').textContent = 'Good ' + part + ', ' + first + '.';
  const idle = state && state.status === 'NEEDS_APPOINTMENT';
  const entries = profile.recurring_care || [];
  const dueEntries = entries.map(function (care, index) { return { care: care, index: index }; })
    .filter(function (entry) { return monthsSince(entry.care.last_visit) >= (entry.care.interval_months || 6); });
  const cards = document.getElementById('needCards');
  cards.hidden = !idle || !dueEntries.length;
  document.getElementById('allSet').hidden = idle && dueEntries.length;
  document.getElementById('homeLead').textContent = !idle
    ? 'Coordination is in progress.'
    : dueEntries.length === 1
      ? 'One task is ready to review.'
      : dueEntries.length > 1
        ? dueEntries.length + ' tasks are ready to review.'
        : 'Nothing needs your attention.';
  if (idle && dueEntries.length) {
    // Keep polling from restarting the card reveal animation.
    const html = dueEntries.map(function (entry) { return careActionCard(entry.care, entry.index); }).join('');
    if (cards.dataset.rendered !== html) {
      cards.innerHTML = html;
      cards.dataset.rendered = html;
      requestAnimationFrame(initRevealAnimations);
    }
  } else {
    cards.dataset.rendered = '';
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
    '<div><span class="preference-icon" aria-hidden="true">AM</span><span><strong>' + esc(titleCase(time)) + '</strong><small>Preferred time</small></span></div>' +
    '<div><span class="preference-icon" aria-hidden="true">M</span><span><strong>' + esc(patient.insurance) + '</strong><small>Coverage</small></span></div>' +
    '<div><span class="preference-icon" aria-hidden="true">W</span><span><strong>' + esc(mobility) + '</strong><small>Ride access</small></span></div>';
  const upcoming = (profile.recurring_care || []).filter(function (care) {
    return monthsSince(care.last_visit) < (care.interval_months || 6);
  }).sort(function (a, b) { return nextDueDate(a) - nextDueDate(b); });
  const upcomingEl = document.getElementById('upcomingCare');
  if (!upcoming.length) {
    upcomingEl.innerHTML = '';
    return;
  }
  upcomingEl.innerHTML = '<span>Coming up later</span>' + upcoming.map(function (care) {
    const date = nextDueDate(care);
    const month = date.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
    return '<div class="upcoming-item"><span class="upcoming-date">' + month + '<br>' + date.getFullYear() + '</span><div><strong>' + esc(titleCase(care.type)) + '</strong><small>' + esc(care.provider) + '</small></div></div>';
  }).join('');
}

function populateProfileForm() {
  if (!profile || !profile.patient) return;
  const names = profile.patient.name.split(' ');
  document.getElementById('f_first').value = names.shift() || '';
  document.getElementById('f_last').value = names.join(' ');
  document.getElementById('f_age').value = profile.patient.age || '';
  document.getElementById('f_street').value = profile.patient.street_address || '';
  document.getElementById('f_town').value = profile.patient.home_location || '';
  document.getElementById('f_ins').value = profile.patient.insurance || 'Medicare';
  document.getElementById('f_pharm').value = profile.patient.preferred_pharmacy || '';
  document.getElementById('f_pharm_addr').value = profile.patient.pharmacy_address || '';
  const mobility = profile.patient.mobility_needs || [];
  document.getElementById('f_walker').checked = mobility.includes('walker');
  document.getElementById('f_wheel').checked = mobility.includes('wheelchair');
  document.getElementById('f_none').checked = mobility.length === 0;
  document.getElementById('f_time').value = (profile.patient.preferred_times && profile.patient.preferred_times[0]) || 'weekday mornings';
  if (profile.caregiver) {
    document.getElementById('f_cgname').value = profile.caregiver.name || '';
    document.getElementById('f_cgphone').value = profile.caregiver.phone || '';
  }
  const list = document.getElementById('rcList');
  list.innerHTML = '';
  (profile.recurring_care || []).forEach(addRcRow);
  if (!list.children.length) addRcRow();
}

function addRcRow(data) {
  data = data || {};
  const row = document.createElement('div');
  row.className = 'rc-entry';
  const index = document.querySelectorAll('.rc-entry').length + 1;
  row.innerHTML = '<div class="rc-entry-head"><strong>Recurring visit ' + index + '</strong>' +
    '<button class="remove-care-button" type="button" onclick="removeRcRow(this)" aria-label="Remove recurring visit">' +
      '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>' +
    '<div class="fgrid">' +
      '<div><label>Type of care</label><input class="rc-type" placeholder="Cardiology follow-up" value="' + esc(data.type || '') + '"></div>' +
      '<div><label>Provider</label><input class="rc-provider" placeholder="Regional Heart Center" value="' + esc(data.provider || '') + '"></div>' +
      '<div class="full"><label>Provider address</label><input class="rc-address" placeholder="2200 Medical Center Drive, Millbrook, PA" value="' + esc(data.address || '') + '"></div>' +
      '<div><label>Repeat every</label><div class="input-suffix"><input class="rc-interval" type="number" min="1" inputmode="numeric" value="' + esc(data.interval_months || 6) + '"><span>months</span></div></div>' +
      '<div><label>Last visit</label><input class="rc-last" type="date" value="' + esc(data.last_visit || '') + '"></div>' +
    '</div>';
  document.getElementById('rcList').appendChild(row);
}

function removeRcRow(button) {
  const rows = document.querySelectorAll('.rc-entry');
  if (rows.length === 1) {
    showToast('Keep at least one recurring visit, or clear its fields.');
    return;
  }
  button.closest('.rc-entry').remove();
  document.querySelectorAll('.rc-entry-head strong').forEach(function (label, index) {
    label.textContent = 'Recurring visit ' + (index + 1);
  });
}

function collectRecurringCare() {
  return Array.from(document.querySelectorAll('.rc-entry')).map(function (row) {
    return {
      type: row.querySelector('.rc-type').value.trim(),
      provider: row.querySelector('.rc-provider').value.trim(),
      address: row.querySelector('.rc-address').value.trim(),
      interval_months: parseInt(row.querySelector('.rc-interval').value, 10) || 6,
      last_visit: row.querySelector('.rc-last').value,
      source: 'caregiver-entered recurring plan'
    };
  }).filter(function (care) { return care.type && care.provider; });
}

function loadDemoData(shouldScroll) {
  const set = function (id, value) { document.getElementById(id).value = value; };
  set('f_first', 'Eleanor');
  set('f_last', 'Brooks');
  set('f_age', 78);
  set('f_street', '412 Laurel Hollow Road');
  set('f_town', 'Pine Ridge, Pennsylvania');
  set('f_ins', 'Medicare');
  set('f_pharm', 'Pine Ridge Pharmacy');
  set('f_pharm_addr', '18 Main Street, Pine Ridge, PA');
  set('f_time', 'weekday mornings');
  set('f_cgname', 'Sarah Brooks');
  set('f_cgphone', '+19736341419');
  document.getElementById('f_walker').checked = true;
  document.getElementById('f_wheel').checked = false;
  document.getElementById('f_none').checked = false;
  document.getElementById('rcList').innerHTML = '';
  addRcRow({
    type: 'cardiology follow-up',
    provider: 'Regional Heart Center',
    address: '2200 Medical Center Drive, Millbrook, PA',
    interval_months: 6,
    last_visit: '2026-02-08'
  });
  addRcRow({
    type: 'eye exam',
    provider: 'Millbrook Vision Care',
    address: '45 Commerce Street, Millbrook, PA',
    interval_months: 12,
    last_visit: '2026-03-10'
  });
  showToast('Eleanor’s profile is loaded. Review and save when ready.');
  if (shouldScroll) setTimeout(function () { scrollToSetup('patient'); }, 120);
}

function scrollToSetup(section) {
  const target = document.getElementById('setup-' + section);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function saveProfile() {
  const firstName = val('f_first').trim();
  const recurringCare = collectRecurringCare();
  if (!firstName) {
    showToast('Add the patient’s first name before saving.');
    document.getElementById('f_first').focus();
    return;
  }
  if (!recurringCare.length) {
    showToast('Add one recurring visit with a care type and provider.');
    scrollToSetup('care');
    return;
  }
  const mobility = [];
  if (document.getElementById('f_walker').checked) mobility.push('walker');
  if (document.getElementById('f_wheel').checked) mobility.push('wheelchair');
  const body = {
    patient: {
      name: (firstName + ' ' + val('f_last')).trim(),
      age: parseInt(val('f_age'), 10) || 0,
      street_address: val('f_street'),
      home_location: val('f_town'),
      insurance: val('f_ins'),
      mobility_needs: mobility,
      preferred_times: [val('f_time')],
      preferred_pharmacy: val('f_pharm'),
      pharmacy_address: val('f_pharm_addr')
    },
    caregiver: {
      name: val('f_cgname'),
      relationship: (profile && profile.caregiver && profile.caregiver.relationship) || 'caregiver',
      phone: val('f_cgphone')
    },
    recurring_care: recurringCare
  };
  const button = document.getElementById('saveBtn');
  button.disabled = true;
  button.textContent = 'Saving...';
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
    showToast('Profile saved. Opening Today...');
    document.getElementById('saveNote').hidden = false;
    renderHome();
    renderDemoIdentity();
    setTimeout(function () {
      document.getElementById('saveNote').hidden = true;
      showView('home', false);
    }, 650);
  } catch (error) {
    showToast('Relage could not save the profile.');
  } finally {
    button.disabled = false;
    button.textContent = 'Save and open Today';
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

let revealObserver = null;
let setupSpy = null;

function initRevealAnimations() {
  const items = document.querySelectorAll('[data-reveal]:not(.revealed)');
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    items.forEach(function (item) { item.classList.add('revealed'); });
    return;
  }
  if (!revealObserver) {
    revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry, index) {
        if (!entry.isIntersecting) return;
        entry.target.style.transitionDelay = Math.min(index * 45, 135) + 'ms';
        entry.target.classList.add('revealed');
        revealObserver.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -30px' });
  }
  items.forEach(function (item) { revealObserver.observe(item); });
}

function initSetupScrollSpy() {
  if (setupSpy) setupSpy.disconnect();
  setupSpy = new IntersectionObserver(function (entries) {
    const visible = entries.filter(function (entry) { return entry.isIntersecting; })
      .sort(function (a, b) { return b.intersectionRatio - a.intersectionRatio; })[0];
    if (!visible) return;
    const section = visible.target.getAttribute('data-setup-section');
    document.querySelectorAll('[data-section-link]').forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-section-link') === section);
    });
  }, { rootMargin: '-18% 0px -62%', threshold: [0, .2, .5] });
  document.querySelectorAll('[data-setup-section]').forEach(function (section) { setupSpy.observe(section); });
}

let scrollTicking = false;
function updateScrollEffects() {
  const root = document.documentElement;
  const max = Math.max(root.scrollHeight - window.innerHeight, 1);
  const progress = Math.min(window.scrollY / max, 1);
  document.getElementById('scrollProgress').style.transform = 'scaleX(' + progress + ')';
  document.body.classList.toggle('page-scrolled', window.scrollY > 36);
  scrollTicking = false;
}

window.addEventListener('scroll', function () {
  if (scrollTicking) return;
  scrollTicking = true;
  requestAnimationFrame(updateScrollEffects);
}, { passive: true });

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
    if (config.voice) status.textContent = 'Voice primary';
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
  showView('setup', true);
  initSetupScrollSpy();
  initRevealAnimations();
  updateScrollEffects();
  poll(false);
}

boot();
