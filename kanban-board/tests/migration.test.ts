import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteBoardRepository } from '../lib/repository';

describe('1~2단계에서 만든 DB 이어 쓰기', () => {
  it('라벨 칸이 없던 옛 cards 테이블에 칸을 덧붙이고 기존 카드를 그대로 보여준다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-mig-'));
    const file = path.join(dir, 'old.db');
    // 2단계까지의 스키마(라벨·체크리스트·댓글·첨부 테이블 없음)를 그대로 재현
    const old = new Database(file);
    old.exec(`
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
      INSERT INTO meta VALUES (1, 3);
      CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL, rev INTEGER NOT NULL);
      CREATE TABLE board_columns (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL, is_done INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL);
      CREATE TABLE cards (id TEXT PRIMARY KEY, column_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', assignee TEXT NOT NULL DEFAULT '', due_date TEXT, repeat TEXT NOT NULL DEFAULT 'none', archived INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL, followup_id TEXT, rev INTEGER NOT NULL);
      CREATE TABLE changes (revision INTEGER NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL);
      INSERT INTO app_settings VALUES ('first_board_created', '1');
      INSERT INTO boards VALUES ('b1', '옛 보드', 0, 1);
      INSERT INTO board_columns VALUES ('c1', 'b1', '할 일', 0, 0, 1);
      INSERT INTO cards VALUES ('k1', 'c1', '옛 카드', '설명', '김', '2026-12-01', 'none', 0, 0, NULL, 2);
    `);
    old.close();

    const repo = new SqliteBoardRepository(file);
    const s = repo.snapshot();
    expect(s.cards).toHaveLength(1);
    expect(s.cards[0]).toMatchObject({ id: 'k1', title: '옛 카드', labels: [], assignee: '김' });
    expect(s.revision).toBe(3);
    // 새 기능도 옛 데이터 위에서 동작한다
    repo.updateCard('k1', { labels: ['red'] });
    repo.addCheck('k1', '항목');
    expect(repo.snapshot().cards[0].labels).toEqual(['red']);
    expect(repo.snapshot().checks).toHaveLength(1);
    // 다시 열어도 문제없다(마이그레이션은 한 번만)
    expect(() => new SqliteBoardRepository(file)).not.toThrow();
  });
});
