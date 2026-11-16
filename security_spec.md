# Security Specification & Invariants

## 1. Data Invariants
1. **PII Isolation**: User email and personal profile data live strictly in `/users/{userId}/private/{docId}` and are readable/writable only by `request.auth.uid == userId` with `email_verified == true`.
2. **Owner-Isolated Saved Tests**: Every saved test in `/users/{userId}/savedTests/{testId}` and its `questions` subcollection must have `ownerId == request.auth.uid == userId`, allowing each student or supervisor to delete their own archive without affecting others.
3. **Room Supervisor Authority**: Only the creator (`supervisorId == request.auth.uid`) can transition room status (`waiting` -> `active` -> `finished`), insert questions, evaluate student boards (`verdict`), or update participant scores.
4. **Student Self-Identity & Board Isolation**: A student can only create a participant record under their own `uid`, and can only draw/submit on their own board (`studentId == request.auth.uid`) while `verdict == 'pending'` and `question.status == 'solving'`.
5. **Terminal State Locking**: Once a room reaches `status == 'finished'` or a question reaches `status == 'correct'` or `status == 'unanswered'`, no further mutations are permitted.
6. **Temporal Integrity**: All `createdAt` and `updatedAt` timestamps must equal `request.time`.

## 2. The "Dirty Dozen" Malicious Payloads
1. **Unverified Email Write**: Attempt to create `/rooms/ABC123` with `email_verified: false`. -> `PERMISSION_DENIED`
2. **PII Cross-Read**: User B attempts `get` on `/users/userA/private/profile`. -> `PERMISSION_DENIED`
3. **Ghost Field Injection**: Create room with extra field `{ isOfficial: true }`. -> `PERMISSION_DENIED`
4. **Identity Spoofing on Room Create**: User A creates room with `supervisorId: "userB"`. -> `PERMISSION_DENIED`
5. **Room Status Shortcutting**: Supervisor updates room directly from `waiting` to `active` while also tampering `supervisorId`. -> `PERMISSION_DENIED`
6. **Terminal Room Mutation**: Attempt to insert question or update room after `room.status == 'finished'`. -> `PERMISSION_DENIED`
7. **Student Self-Grading**: Student updates own board with `verdict: 'correct'`. -> `PERMISSION_DENIED`
8. **Cross-Student Board Vandalism**: Student A updates Student B's board strokes. -> `PERMISSION_DENIED`
9. **Post-Wrong Re-submission**: Student whose board has `verdict == 'wrong'` attempts to update `strokes` or `submitted`. -> `PERMISSION_DENIED`
10. **Post-Winner Drawing**: Student attempts to draw after `question.status == 'correct'`. -> `PERMISSION_DENIED`
11. **ID Poisoning**: Attempt to write `/rooms/bad$id!with*1500chars...` exceeding 128 chars or failing regex. -> `PERMISSION_DENIED`
12. **Client Timestamp Forgery**: Create participant with backdated `joinedAt` instead of server `request.time`. -> `PERMISSION_DENIED`
