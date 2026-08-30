import { v4 as uuidv4 } from 'uuid';
import { User } from '@/types';

const USER_COLORS = [
  '#3B82F6', '#10B981', '#F59E0B', '#EF4444',
  '#8B5CF6', '#06B6D4', '#EC4899', '#14B8A6',
];

function randomColor(): string {
  return USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
}

export function getOrCreateUser(): User {
  if (typeof window === 'undefined') {
    return { userId: 'ssr', username: 'User', color: '#3B82F6' };
  }

  const stored = localStorage.getItem('wb:user');
  if (stored) {
    try { return JSON.parse(stored); } catch { /* fall through */ }
  }

  const user: User = {
    userId: uuidv4(),
    username: `User-${Math.floor(Math.random() * 9000) + 1000}`,
    color: randomColor(),
  };

  localStorage.setItem('wb:user', JSON.stringify(user));
  return user;
}

export function updateUsername(username: string): User {
  const user = { ...getOrCreateUser(), username };
  localStorage.setItem('wb:user', JSON.stringify(user));
  return user;
}
