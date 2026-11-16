/**
 * Security Rules Specification Verification Tests ("Dirty Dozen" Payloads)
 * Designed for Firebase Emulator Rules Unit Testing.
 */

export const DIRTY_DOZEN_PAYLOADS = [
  {
    name: '01_unverified_email_create_room',
    path: '/rooms/ROOM01',
    auth: { uid: 'user1', token: { email_verified: false } },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '02_pii_cross_user_read',
    path: '/users/userA/private/profile',
    auth: { uid: 'userB', token: { email_verified: true } },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '03_ghost_field_injection_on_room',
    path: '/rooms/ROOM01',
    payload: { id: 'ROOM01', isOfficial: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '04_identity_spoofing_supervisor_id',
    path: '/rooms/ROOM01',
    auth: { uid: 'attacker', token: { email_verified: true } },
    payload: { supervisorId: 'victim_uid' },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '05_room_status_shortcut_with_tampered_owner',
    path: '/rooms/ROOM01',
    payload: { status: 'active', supervisorId: 'other' },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '06_terminal_room_mutation_after_finished',
    path: '/rooms/ROOM01',
    existingStatus: 'finished',
    payload: { status: 'active' },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '07_student_self_grading_board_verdict',
    path: '/rooms/ROOM01/questions/q1/boards/student1',
    auth: { uid: 'student1', token: { email_verified: true } },
    payload: { verdict: 'correct' },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '08_cross_student_board_vandalism',
    path: '/rooms/ROOM01/questions/q1/boards/student2',
    auth: { uid: 'student1', token: { email_verified: true } },
    payload: { strokes: [] },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '09_post_wrong_resubmission',
    path: '/rooms/ROOM01/questions/q1/boards/student1',
    auth: { uid: 'student1', token: { email_verified: true } },
    existingBoard: { submitted: true, verdict: 'wrong' },
    payload: { submitted: false },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '10_post_winner_drawing',
    path: '/rooms/ROOM01/questions/q1/boards/student2',
    auth: { uid: 'student2', token: { email_verified: true } },
    questionStatus: 'correct',
    payload: { strokes: [{ color: '#1F2937', width: 4, isEraser: false, pts: [0, 0, 10, 10] }] },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '11_id_poisoning_invalid_chars',
    path: '/rooms/bad$id!poison',
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '12_client_timestamp_forgery',
    path: '/rooms/ROOM01/participants/student1',
    payload: { joinedAt: '2020-01-01T00:00:00Z' },
    expected: 'PERMISSION_DENIED',
  },
];
