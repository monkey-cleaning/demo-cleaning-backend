// services/conflictDetection.js
//
// Port literal de frontend/src/lib/conflictDetection.ts — funciones puras,
// sin fetch. Mantener ambos archivos en sync si se toca la lógica de
// solapamiento/capacidad.

function overlaps(aStart, aEnd, bStart, bEnd) {
  return new Date(aStart).getTime() < new Date(bEnd).getTime()
      && new Date(aEnd).getTime()   > new Date(bStart).getTime();
}

export function findTeamOverlaps(events) {
  const out = [];
  const byTeam = new Map();

  for (const e of events) {
    if (!e.teamId || e.isAllDay || e.isNonService) continue;
    const list = byTeam.get(e.teamId) ?? [];
    list.push(e);
    byTeam.set(e.teamId, list);
  }

  for (const [teamId, list] of byTeam) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (overlaps(a.startIso, a.endIso, b.startIso, b.endIso)) {
          out.push({ eventId: a.id, conflictingEventId: b.id, conflictingSummary: b.summary, teamId });
          out.push({ eventId: b.id, conflictingEventId: a.id, conflictingSummary: a.summary, teamId });
        }
      }
    }
  }
  return out;
}

export function findOverCapacity(events, maxSimultaneousTeams) {
  const assigned = events.filter((e) => e.teamId && !e.isAllDay && !e.isNonService);
  if (assigned.length === 0) return [];

  const points = [];
  for (const e of assigned) {
    points.push({ time: new Date(e.startIso).getTime(), delta: 1, eventId: e.id });
    points.push({ time: new Date(e.endIso).getTime(), delta: -1, eventId: e.id });
  }
  points.sort((a, b) => a.time - b.time || a.delta - b.delta);

  const active = new Set();
  const flagged = new Map();

  for (const p of points) {
    if (p.delta === 1) {
      active.add(p.eventId);
      if (active.size > maxSimultaneousTeams) {
        for (const id of active) flagged.set(id, Math.max(flagged.get(id) ?? 0, active.size));
      }
    } else {
      active.delete(p.eventId);
    }
  }

  return Array.from(flagged.entries()).map(([eventId, simultaneousCount]) => ({
    eventId, simultaneousCount, maxTeams: maxSimultaneousTeams,
  }));
}