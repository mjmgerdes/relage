'use strict';

document.getElementById('hostedNotice').hidden = false;

let DEMO_PROFILE = {
  patient: {
    name: 'Eleanor Brooks',
    age: 78,
    home_location: 'Pine Ridge, Pennsylvania',
    street_address: '412 Laurel Hollow Road',
    insurance: 'Medicare',
    mobility_needs: ['walker'],
    preferred_times: ['weekday mornings'],
    preferred_pharmacy: 'Pine Ridge Pharmacy',
    pharmacy_address: '18 Main Street, Pine Ridge, PA'
  },
  caregiver: {
    name: 'Sarah Brooks',
    relationship: 'daughter',
    phone: '+19736341419'
  },
  recurring_care: [{
    type: 'cardiology follow-up',
    provider: 'Regional Heart Center',
    address: '825 Medical Campus Drive, Millbrook, PA',
    interval_months: 6,
    last_visit: '2026-02-08',
    source: 'patient-entered recurring plan'
  }, {
    type: 'annual eye exam',
    provider: 'Pine Ridge Vision Center',
    address: '94 Market Street, Pine Ridge, PA',
    interval_months: 12,
    last_visit: '2026-04-22',
    source: 'patient-entered recurring plan'
  }]
};

let DEMO_CARE_INDEX = 0;

const BASE_CALENDAR = function () {
  return [{
    date: '2026-02-08',
    time: '10:00 AM',
    title: 'Cardiology follow-up · Regional Heart Center',
    kind: 'past',
    status: 'completed'
  }];
};

const DEMO_SLOT = function (careIndex) {
  const care = DEMO_PROFILE.recurring_care[careIndex] || DEMO_PROFILE.recurring_care[0];
  return {
    date: '2026-08-11',
    time: '10:30 AM',
    day: 'Tuesday',
    provider: care.provider,
    care_type: care.type,
    distance_miles: 34,
    status: 'held'
  };
};

const DEMO_VAN = {
  name: 'Pine Ridge Medical Access Van',
  type: 'accessible_transport',
  pickup_time: '8:55 AM',
  return_pickup_time: '12:15 PM'
};

let DEMO_STATE = null;
let demoTimers = [];

function demoPatientFirst() {
  return DEMO_PROFILE.patient.name.split(' ')[0];
}

function demoCaregiverFirst() {
  return DEMO_PROFILE.caregiver.name.split(' ')[0];
}

function demoReset() {
  demoTimers.forEach(clearTimeout);
  demoTimers = [];
  DEMO_STATE = {
    status: 'NEEDS_APPOINTMENT',
    activity: [],
    appointment: null,
    transport: null,
    caregiver_reply: null,
    plan_explanation: '',
    calendar: BASE_CALENDAR(),
    sms_outbox: [],
    busy: false
  };
}

function demoLog(kind, text, friendly, sources) {
  DEMO_STATE.activity.push({ kind: kind, text: text, friendly: friendly || null, sources: sources || [] });
}

function demoStage(delay, action) {
  demoTimers.push(setTimeout(action, delay));
}

function demoCoordinate(careIndex) {
  if (DEMO_STATE.status !== 'NEEDS_APPOINTMENT' || DEMO_STATE.busy) {
    return { error: 'Care journey already started' };
  }
  DEMO_CARE_INDEX = Number.isInteger(careIndex) ? careIndex : 0;
  const care = DEMO_PROFILE.recurring_care[DEMO_CARE_INDEX] || DEMO_PROFILE.recurring_care[0];
  DEMO_STATE.busy = true;
  DEMO_STATE.care_index = DEMO_CARE_INDEX;
  const slot = DEMO_SLOT(DEMO_CARE_INDEX);
  const careLabel = care.type.replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
  demoStage(700, function () {
    demoLog('gemma', 'Plan: search_providers [gemma4:8b 9.8s]', 'Checking ' + careLabel.toLowerCase() + ' providers that take ' + DEMO_PROFILE.patient.insurance + '.', [
      { label: 'medicare.gov/care-compare', url: 'https://www.medicare.gov/care-compare/' }
    ]);
  });
  demoStage(1550, function () {
    demoLog('tool', 'search_providers: 1 in-network match', care.provider + ' takes ' + DEMO_PROFILE.patient.insurance + '.', [
      { label: care.provider + ' · provider listing', url: 'https://www.google.com/search?q=' + encodeURIComponent(care.provider + ' Pennsylvania') }
    ]);
  });
  demoStage(2400, function () {
    demoLog('tool', 'check_availability: Tuesday 2026-08-11 at 10:30 AM', 'They have a Tuesday morning opening at 10:30 AM.', [
      { label: care.provider + ' · scheduling', url: 'https://www.google.com/search?q=' + encodeURIComponent(care.provider + ' appointments') }
    ]);
  });
  demoStage(3200, function () {
    DEMO_STATE.appointment = slot;
    DEMO_STATE.status = 'APPOINTMENT_HELD';
    demoLog('state', 'Appointment held pending patient approval', 'Relage is holding that time. It is not booked yet.');
  });
  demoStage(4050, function () {
    DEMO_STATE.status = 'TRANSPORT_NEEDED';
    demoLog('state', '34-mile trip requires transport coordination', 'The office is 34 miles away. Relage is arranging the ride.');
  });
  demoStage(4850, function () {
    demoLog('adapt', 'Caregiver accepted 1 of 4 prior ride requests; accessible fallback prepared', null);
  });
  demoStage(5750, function () {
    DEMO_STATE.sms_outbox.push({
      to: DEMO_PROFILE.caregiver.name,
      phone: DEMO_PROFILE.caregiver.phone,
      body: 'Hi ' + demoCaregiverFirst() + ', ' + demoPatientFirst() + ' has a ' + care.type + ' available Tuesday, August 11 at 10:30 AM at ' + care.provider + '. Can you drive her? Reply YES or NO.',
      time: '',
      via: 'simulator'
    });
    DEMO_STATE.status = 'CAREGIVER_CONTACTED';
    DEMO_STATE.busy = false;
    demoLog('sms', 'Minimum-necessary appointment details sent to caregiver', 'Relage asked ' + demoCaregiverFirst() + ' about the ride.');
  });
  return { started: true };
}

function demoCaregiverReply(text) {
  if (DEMO_STATE.status !== 'CAREGIVER_CONTACTED') {
    return { error: 'No caregiver request is waiting' };
  }
  DEMO_STATE.busy = true;
  const normalized = text.toLowerCase();
  const accepts = (/\byes\b|i can\b|sure/.test(normalized)) && !(/\bno\b|can't|cannot|busy|meeting|not home|but not/.test(normalized));
  if (accepts) {
    demoStage(900, function () {
      demoLog('gemma', 'Reply classified: can_drive=true [gemma3:4b 2.7s]', demoCaregiverFirst() + ' can drive you.');
    });
    demoStage(1850, function () {
      DEMO_STATE.transport = {
        name: DEMO_PROFILE.caregiver.name,
        type: 'caregiver',
        pickup_time: '9:15 AM',
        return_pickup_time: 'after appointment'
      };
      DEMO_STATE.plan_explanation = 'The appointment matches your morning preference, and Sarah can take you door to door.';
      DEMO_STATE.status = 'AWAITING_USER_CONFIRMATION';
      DEMO_STATE.busy = false;
      demoLog('state', 'Complete plan ready for patient approval', 'Your appointment and ride are ready to review.');
    });
  } else {
    demoStage(900, function () {
      demoLog('gemma', 'Reply classified: can_drive=false [gemma3:4b 2.9s]', demoCaregiverFirst() + ' cannot drive that day.');
    });
    demoStage(1700, function () {
      DEMO_STATE.status = 'CAREGIVER_UNAVAILABLE';
      demoLog('state', 'Caregiver unavailable; fallback search started', 'Relage is finding another ride.');
    });
    demoStage(2550, function () {
      demoLog('tool', 'check_transport: 2 walker-accessible options', 'Two local services can carry your walker.', [
        { label: 'Pine Ridge Medical Access Van', url: 'https://www.google.com/search?q=Pennsylvania+rural+medical+transportation' },
        { label: 'findarideguide.org · PA rural transit', url: 'https://www.google.com/search?q=Pennsylvania+rural+medical+transportation+directory' }
      ]);
    });
    demoStage(3450, function () {
      DEMO_STATE.transport = DEMO_VAN;
      DEMO_STATE.status = 'TRANSPORT_FOUND';
      demoLog('gemma', 'Selected medical access van: walker support, 34-mile service area, Medicare fare [gemma4:8b 11.6s]', 'Pine Ridge Medical Access Van can take you.');
    });
    demoStage(4350, function () {
      DEMO_STATE.plan_explanation = 'The visit matches your morning preference. The medical access van has room for your walker and the county program covers the fare for Medicare riders.';
      DEMO_STATE.status = 'AWAITING_USER_CONFIRMATION';
      DEMO_STATE.busy = false;
      demoLog('state', 'Complete plan ready for patient approval', 'Your appointment and ride are ready to review.');
    });
  }
  return { received: true };
}

function demoConfirm() {
  if (DEMO_STATE.status !== 'AWAITING_USER_CONFIRMATION') {
    return { error: 'No plan is waiting for approval' };
  }
  const appointment = DEMO_STATE.appointment;
  const transport = DEMO_STATE.transport;
  DEMO_STATE.status = 'CONFIRMED';
  if (transport.pickup_time) {
    DEMO_STATE.calendar.push({
      date: appointment.date,
      time: transport.pickup_time,
      title: 'Pickup · ' + transport.name,
      kind: 'transport',
      status: 'reserved'
    });
  }
  DEMO_STATE.calendar.push({
    date: appointment.date,
    time: appointment.time,
    title: appointment.care_type + ' · ' + appointment.provider,
    kind: 'appointment',
    status: 'confirmed'
  });
  if (transport.return_pickup_time && !transport.return_pickup_time.includes('after')) {
    DEMO_STATE.calendar.push({
      date: appointment.date,
      time: transport.return_pickup_time,
      title: 'Return transportation pickup',
      kind: 'transport',
      status: 'reserved'
    });
  }
  DEMO_STATE.calendar.push({
    date: '2027-02-10',
    time: '',
    title: 'Next ' + appointment.care_type + ' window',
    kind: 'future',
    status: 'scheduled'
  });
  DEMO_STATE.sms_outbox.push({
    to: DEMO_PROFILE.patient.name,
    phone: '(this device)',
    body: 'Your ' + appointment.care_type + ' and ride are confirmed for Tuesday, August 11.',
    time: '',
    via: 'simulator'
  });
  DEMO_STATE.sms_outbox.push({
    to: DEMO_PROFILE.caregiver.name,
    phone: DEMO_PROFILE.caregiver.phone,
    body: demoPatientFirst() + '’s appointment and ride are confirmed for Tuesday, August 11.',
    time: '',
    via: 'simulator'
  });
  demoLog('state', 'Plan confirmed; calendar and reminders updated', null);
  return DEMO_STATE;
}

function demoOnboarding(text) {
  const preferences = [];
  if (/morning/i.test(text)) preferences.push({ field: 'preferred_times', value: 'Weekday mornings' });
  if (/dark|night/i.test(text)) preferences.push({ field: 'transport_preference', value: 'Daytime travel only' });
  if (!preferences.length) preferences.push({ field: 'care_note', value: text.slice(0, 80) });
  return {
    preferences: preferences,
    summary: 'Gemma found ' + preferences.length + (preferences.length === 1 ? ' preference.' : ' preferences.')
  };
}

demoReset();

window.fetch = async function (url, options) {
  const path = url.toString().replace(/^https?:\/\/[^/]+/, '');
  const response = function (data, ok) {
    return { ok: ok !== false, json: async function () { return data; } };
  };
  await new Promise(function (resolve) { setTimeout(resolve, 50); });
  if (path.endsWith('/state')) return response(DEMO_STATE);
  if (path.endsWith('/profile') && options && options.method === 'POST') {
    const body = JSON.parse(options.body);
    if (body.patient) DEMO_PROFILE.patient = Object.assign({}, DEMO_PROFILE.patient, body.patient);
    if (body.caregiver) DEMO_PROFILE.caregiver = Object.assign({}, DEMO_PROFILE.caregiver, body.caregiver);
    if (body.recurring_care) DEMO_PROFILE.recurring_care = body.recurring_care;
    demoReset();
    return response(DEMO_PROFILE);
  }
  if (path.endsWith('/profile')) return response(DEMO_PROFILE);
  if (path.endsWith('/config')) return response({ twilio: false, voice: false, caregiver_phone: DEMO_PROFILE.caregiver.phone });
  if (path.endsWith('/calendar')) return response({ events: DEMO_STATE.calendar });
  if (path.endsWith('/coordinate')) {
    const body = options && options.body ? JSON.parse(options.body) : {};
    return response(demoCoordinate(body.index));
  }
  if (path.endsWith('/caregiver-response')) return response(demoCaregiverReply(JSON.parse(options.body).text));
  if (path.endsWith('/confirm-plan')) return response(demoConfirm());
  if (path.endsWith('/onboarding-note')) return response(demoOnboarding(JSON.parse(options.body).text));
  if (path.endsWith('/reset')) {
    demoReset();
    return response({ reset: true });
  }
  return response({});
};
