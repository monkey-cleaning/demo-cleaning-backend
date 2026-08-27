// Tests de pickFreeTeam(): el reparto de turnos sin `team_id`.
//
// Es la única decisión no trivial del generador de disponibilidad y no se puede
// ejercitar contra la base — hoy no hay ningún appointment sin team_id, así que
// una corrida real nunca pasa por este código.
//
//   npm test

import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";

import { pickFreeTeam } from "../src/services/availabilityGeneratorService.js";

const TZ = "America/Vancouver";
const DAY = "2026-09-15";
const TEAMS = ["team_1", "team_2", "team_3"];

/** Intervalo del día DAY entre dos horas locales, p. ej. at(9, 12). */
function at(startHour, endHour) {
  return {
    start: DateTime.fromISO(`${DAY}T${String(startHour).padStart(2, "0")}:00`, { zone: TZ }),
    end: DateTime.fromISO(`${DAY}T${String(endHour).padStart(2, "0")}:00`, { zone: TZ }),
  };
}

/** Mapa de ocupación { team_1: [[9,12]], ... } → Map con clave "team|dia". */
function busyMap(spec) {
  const m = new Map();
  for (const [team, ranges] of Object.entries(spec)) {
    m.set(`${team}|${DAY}`, ranges.map(([s, e]) => at(s, e)));
  }
  return m;
}

test("con todos los equipos vacíos elige el primero", () => {
  const { team, free } = pickFreeTeam(TEAMS, busyMap({}), DAY, at(9, 12));
  assert.equal(team, "team_1");
  assert.equal(free, true);
});

test("saltea el equipo ocupado y toma el siguiente libre", () => {
  const busy = busyMap({ team_1: [[8, 13]] });
  const { team, free } = pickFreeTeam(TEAMS, busy, DAY, at(9, 12));
  assert.equal(team, "team_2");
  assert.equal(free, true);
});

test("un turno que no solapa no bloquea al equipo", () => {
  // team_1 ocupado a la mañana; el turno es a la tarde → sigue siendo elegible.
  const busy = busyMap({ team_1: [[7, 9]] });
  const { team, free } = pickFreeTeam(TEAMS, busy, DAY, at(9, 12));
  assert.equal(team, "team_1");
  assert.equal(free, true);
});

test("solape parcial cuenta como ocupado", () => {
  // team_1 termina 10:00, el turno arranca 09:00 → se pisan una hora.
  const busy = busyMap({ team_1: [[7, 10]] });
  const { team } = pickFreeTeam(TEAMS, busy, DAY, at(9, 12));
  assert.equal(team, "team_2");
});

test("bordes que se tocan no son solape", () => {
  // team_1 libera 09:00 justo cuando arranca el turno.
  const busy = busyMap({ team_1: [[7, 9]] });
  const { team, free } = pickFreeTeam(TEAMS, busy, DAY, at(9, 12));
  assert.equal(team, "team_1");
  assert.equal(free, true);
});

test("con todos ocupados cae al primero y avisa que no estaba libre", () => {
  const busy = busyMap({
    team_1: [[8, 13]],
    team_2: [[8, 13]],
    team_3: [[8, 13]],
  });
  const { team, free } = pickFreeTeam(TEAMS, busy, DAY, at(9, 12));
  assert.equal(team, "team_1");
  assert.equal(free, false);
});

test("la ocupación de otro día no interfiere", () => {
  const m = new Map();
  m.set(`team_1|2026-09-14`, [at(8, 13)]);
  const { team, free } = pickFreeTeam(TEAMS, m, DAY, at(9, 12));
  assert.equal(team, "team_1");
  assert.equal(free, true);
});

test("es determinista: mismas entradas, mismo equipo", () => {
  const busy = busyMap({ team_1: [[8, 13]] });
  const a = pickFreeTeam(TEAMS, busy, DAY, at(9, 12));
  const b = pickFreeTeam(TEAMS, busy, DAY, at(9, 12));
  assert.deepEqual(a, b);
});
