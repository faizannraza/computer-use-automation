import { Router } from 'express';
import { findMemberById, formatMoney, searchMembers } from '../data/seed.js';
import { consumeNativeDialog, peekFault } from '../faults.js';
import { currentUser } from '../session.js';

export const membersRouter = Router();

membersRouter.get('/search', (req, res) => {
  res.render('member_search', {
    title: 'MockCore Teller — Member Search',
    user: currentUser(req),
    query: null,
    results: null,
    duplicateButton: Boolean(peekFault('duplicate_button')),
    nativeDialogText: consumeNativeDialog(),
  });
});

// Legacy pattern: the search POST renders results on the same screen
// (no post-redirect-get).
membersRouter.post('/search', (req, res) => {
  const query = String((req.body as { txtQuery?: string }).txtQuery ?? '');
  res.render('member_search', {
    title: 'MockCore Teller — Member Search',
    user: currentUser(req),
    query,
    results: searchMembers(query),
    duplicateButton: Boolean(peekFault('duplicate_button')),
    nativeDialogText: consumeNativeDialog(),
  });
});

membersRouter.get('/:id', (req, res) => {
  const member = findMemberById(req.params.id);
  if (!member) {
    res.status(404).render('error', {
      title: 'MockCore Teller — Member Not Found',
      code: 'MBR-4041',
      message: `Member number ${req.params.id} was not found on this system.`,
      user: currentUser(req),
    });
    return;
  }
  res.render('member_detail', {
    title: `MockCore Teller — Member ${member.id}`,
    user: currentUser(req),
    member,
    formatMoney,
    nativeDialogText: consumeNativeDialog(),
  });
});
