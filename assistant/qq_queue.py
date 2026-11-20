"""Durable QQ delivery receipts and retry state."""
import sqlite3
import time
import uuid
from contextlib import closing


class Inbox:
    def __init__(self, path, app_id):
        self.path = path
        self.app_id = app_id
        with closing(self.connect()) as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS qq_jobs (
                    app TEXT NOT NULL, owner TEXT NOT NULL, mid TEXT NOT NULL,
                    kind TEXT NOT NULL, target TEXT NOT NULL, prompt TEXT NOT NULL,
                    mode TEXT NOT NULL, reply TEXT, status TEXT NOT NULL DEFAULT 'ready',
                    seq INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0,
                    available REAL NOT NULL DEFAULT 0, lease TEXT, expires REAL NOT NULL,
                    error TEXT, bound_cid TEXT, PRIMARY KEY (app, owner, mid)
                );
                CREATE INDEX IF NOT EXISTS qq_work ON qq_jobs(app, status, available);
            """)

    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        return db

    def put(self, owner, mid, kind, target, prompt, mode):
        with closing(self.connect()) as db, db:
            db.execute("""
                INSERT INTO qq_jobs(app,owner,mid,kind,target,prompt,mode,expires)
                VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(app,owner,mid) DO NOTHING
            """, (self.app_id, owner, mid, kind, target, prompt, mode, time.time() + 3540))

    def claim(self):
        now = time.time()
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            # Retain identifiers long enough to suppress platform redeliveries.
            db.execute("DELETE FROM qq_jobs WHERE app=? AND expires < ?",
                       (self.app_id, now - 7 * 86400))
            db.execute("""UPDATE qq_jobs SET status='failed',error='expired',prompt='',reply=NULL
                WHERE app=? AND status='ready' AND expires<=?""", (self.app_id, now))
            row = db.execute("""
                SELECT q.rowid AS job_id, q.* FROM qq_jobs q
                WHERE q.app=? AND q.status='ready' AND q.available<=?
                  AND NOT EXISTS (SELECT 1 FROM qq_jobs prior WHERE prior.app=q.app
                    AND prior.owner=q.owner AND prior.status='ready' AND prior.rowid<q.rowid)
                ORDER BY q.rowid LIMIT 1
            """, (self.app_id, now)).fetchone()
            if row is None:
                return None
            job = dict(row)
            job["lease"] = uuid.uuid4().hex
            db.execute("""UPDATE qq_jobs SET available=?,lease=? WHERE rowid=?""",
                       (now + 600, job["lease"], job["job_id"]))
            return job

    def update(self, job, **fields):
        columns = ", ".join(f"{column}=?" for column in fields)
        with closing(self.connect()) as db, db:
            updated = db.execute(f"UPDATE qq_jobs SET {columns} WHERE rowid=? AND lease=? AND status='ready'",
                                 (*fields.values(), job["job_id"], job["lease"]))
            if updated.rowcount != 1:
                raise RuntimeError("QQ job lease expired")
        job.update(fields)
