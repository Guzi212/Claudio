import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_VOLUME,
  VOLUME_PREF_KEY,
  createVolumeSaver,
  defaultVolume,
  readSavedVolume,
} from '../server/volume-store.js';

function memoryDb(initial = {}) {
  const prefs = { ...initial };
  const setPref = vi.fn((key, value) => {
    prefs[key] = value == null ? null : String(value);
  });
  return {
    prefs,
    setPref,
    db: {
      getPref: key => (Object.prototype.hasOwnProperty.call(prefs, key) ? prefs[key] : null),
      setPref,
    },
  };
}

describe('音量默认值和已保存值', () => {
  it('没存过、也没设环境变量时是 30', () => {
    expect(DEFAULT_VOLUME).toBe(30);
    expect(defaultVolume({})).toBe(30);
    expect(readSavedVolume(memoryDb().db, {})).toBe(30);
  });

  it('CLAUDIO_DEFAULT_VOLUME 覆盖默认值，非法值仍回 30', () => {
    expect(defaultVolume({ CLAUDIO_DEFAULT_VOLUME: '45' })).toBe(45);
    expect(defaultVolume({ CLAUDIO_DEFAULT_VOLUME: '0' })).toBe(0);
    expect(defaultVolume({ CLAUDIO_DEFAULT_VOLUME: '150' })).toBe(100);
    expect(defaultVolume({ CLAUDIO_DEFAULT_VOLUME: 'nope' })).toBe(30);
    expect(defaultVolume({ CLAUDIO_DEFAULT_VOLUME: '' })).toBe(30);
  });

  it('prefs 里的音量优先于环境变量', () => {
    const { db } = memoryDb({ [VOLUME_PREF_KEY]: '12' });
    expect(readSavedVolume(db, { CLAUDIO_DEFAULT_VOLUME: '80' })).toBe(12);
    expect(readSavedVolume(memoryDb({ [VOLUME_PREF_KEY]: '0' }).db, {})).toBe(0);
    expect(readSavedVolume(memoryDb({ [VOLUME_PREF_KEY]: 'abc' }).db, {})).toBe(30);
  });
});

describe('音量写入节流', () => {
  it('相同值只写一次，间隔内的新值延后写成最后一次', () => {
    let clock = 1_000_000;
    const scheduled = [];
    const { db, prefs, setPref } = memoryDb();
    const saver = createVolumeSaver({
      db,
      now: () => clock,
      minIntervalMs: 2000,
      schedule: (fn, delay) => { scheduled.push({ fn, delay }); },
    });

    expect(saver.remember(40)).toBe(40);
    expect(setPref).toHaveBeenCalledTimes(1);
    expect(prefs[VOLUME_PREF_KEY]).toBe('40');

    saver.remember(40);
    expect(setPref).toHaveBeenCalledTimes(1);

    clock += 100;
    expect(saver.remember(80)).toBe(80);
    expect(saver.remember(55)).toBe(55);
    expect(setPref).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delay).toBe(1900);

    clock += 1900;
    scheduled[0].fn();
    expect(prefs[VOLUME_PREF_KEY]).toBe('55');
    expect(setPref).toHaveBeenCalledTimes(2);
  });

  it('force 在间隔内也会立刻写', () => {
    let clock = 5_000;
    const { db, prefs, setPref } = memoryDb();
    const saver = createVolumeSaver({
      db,
      now: () => clock,
      minIntervalMs: 2000,
      schedule: () => {},
    });
    saver.remember(40);
    clock += 10;
    expect(saver.remember(18, { force: true })).toBe(18);
    expect(prefs[VOLUME_PREF_KEY]).toBe('18');
    expect(setPref).toHaveBeenCalledTimes(2);
  });

  it('记住之后重新读 prefs，等于刚才写入的值', () => {
    const { db } = memoryDb();
    const saver = createVolumeSaver({ db, schedule: () => {} });
    saver.remember(37);
    expect(readSavedVolume(db, { CLAUDIO_DEFAULT_VOLUME: '90' })).toBe(37);
  });
});
