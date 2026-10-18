/*!
 * Copyright (C) 2026 Lju
 *
 * This file is part of Astra Monitor extension for GNOME Shell.
 * [https://github.com/AstraExt/astra-monitor]
 *
 * Astra Monitor is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Astra Monitor is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * The pure helpers of the Intel GPU monitor, checked against data captured on real
 * hardware: every fixture under test/fixtures/ is an untouched copy of what the kernel
 * reported, under the paths it reported it at, taken on the machine named in the
 * describe() blocks below.
 *
 * The capture holds two scans of the DRM clients two seconds apart
 * (fdinfo-xe-pantherlake/t0, t1) and the sysfs tree (sysfs-xe-pantherlake/), both while
 * three 4K VAAPI encodes and glxgears were running, and four snapshots of the sleep
 * counters of both GTs: one clean second under that same load
 * (gtidle-xe-pantherlake/load0, load1) and two clean seconds with the GPU idle (idle0,
 * idle1 and idle2, idle3), so that one idle interval can be measured against a mark
 * learned from the other. The counter snapshots do not cover the same instants as the
 * client scans, only the same load. Neither sleep counter advances at the rate of the
 * clock, and the rate of a single one second window is not a constant either: sampled
 * over sixty of them with the GPU idle, the render GT's ranged 0.845 to 0.947 and the
 * media GT's 0.701 to 0.845, against 0 to 0.08 for a GT saturated by a decode. The two
 * idle snapshots here sit near the bottom of those bands, which is why they
 * cross-calibrate to a couple of per cent; a pair taken from opposite ends of one would
 * not.
 *
 * Run with `npm test` (node --test). The runner ships with Node and strips the types,
 * so the TypeScript source is imported directly and there is no dependency to add.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

import {
    INTEL_SAMPLE_FLUSH,
    intelActivity,
    intelActivityFromRates,
    intelActivityFromRc6,
    intelFdinfoSample,
    intelFrequency,
    intelMaxRates,
    intelPower,
    intelResidencyRates,
    intelVram,
    isIntegratedIntelGpu,
    parseIntelGpuSample,
    parseMemTotal,
    parseSysfsNumber,
} from '../src/gpu/intelGpuUtils.ts';

const HARDWARE = 'Intel Panther Lake [Arc B390] (8086:b080) at 0000:00:02.0, xe driver';
const SOFTWARE = 'Linux 7.2.2-1-cachyos, GNOME Shell 50.4, intel-gpu-tools 2.5-1';
const PDEV = '0000:00:02.0';

const SYSFS = new URL('fixtures/sysfs-xe-pantherlake/', import.meta.url);
const FDINFO = new URL('fixtures/fdinfo-xe-pantherlake/', import.meta.url);
const GTIDLE = new URL('fixtures/gtidle-xe-pantherlake/', import.meta.url);

const xeRead = path => readFileSync(new URL(path, SYSFS), 'utf8');
const xeHas = path => existsSync(new URL(path, SYSFS));
const GT = n => `class/drm/card0/device/tile0/${n}`;

/** A scan of the descriptors open on /dev/dri, as the monitor hands it over */
const fdinfoScan = (snapshot, order = files => files) => {
    const descriptors = new Map();
    for(const file of order(readdirSync(new URL(`${snapshot}/`, FDINFO)).sort())) {
        const [, name, pid] = /^(.+)-(\d+)-\d+$/.exec(file);
        descriptors.set(file, {
            pid: parseInt(pid, 10),
            name,
            content: readFileSync(new URL(`${snapshot}/${file}`, FDINFO), 'utf8'),
        });
    }
    return descriptors;
};

/** The sleep counters of every GT at the instant of one snapshot, in milliseconds */
const residencies = snapshot => ({
    [GT('gt0')]: parseInt(readFileSync(new URL(`${snapshot}/gt0`, GTIDLE), 'utf8'), 10),
    [GT('gt1')]: parseInt(readFileSync(new URL(`${snapshot}/gt1`, GTIDLE), 'utf8'), 10),
});
const clock = snapshot => parseFloat(readFileSync(new URL(`${snapshot}/clock`, GTIDLE), 'utf8'));
const ratesOf = (before, after) =>
    intelResidencyRates(residencies(before), residencies(after), clock(after) - clock(before));

describe(`Intel GPU on ${HARDWARE} — ${SOFTWARE}`, { concurrency: false }, () => {
    test('the attributes the i915 path reads are not there on xe, and degrade to nothing', () => {
        // This is the gap: a monitor that only knows the i915 layout reads nothing here
        assert.equal(xeHas('class/drm/card0/gt_cur_freq_mhz'), false);
        assert.equal(xeHas('class/drm/card0/gt_max_freq_mhz'), false);
        assert.equal(xeHas('class/drm/card0/gt_min_freq_mhz'), false);
        assert.equal(xeHas('class/drm/card0/power/rc6_residency_ms'), false);

        // and an unreadable file is no reading rather than a zero or a NaN
        assert.equal(parseSysfsNumber(''), undefined);
        assert.equal(parseSysfsNumber('\n'), undefined);
        assert.equal(parseSysfsNumber('unknown'), undefined);
        assert.equal(intelFrequency(undefined, '', ''), undefined);
        assert.equal(intelActivityFromRc6(undefined, undefined, 1), undefined);
    });

    test('xe keeps them per GT, under the PCI device, and names the GTs', () => {
        // Which GT is the render one is not fixed, so the name is what tells them apart
        assert.equal(xeRead(`${GT('gt0')}/gtidle/name`).trim(), 'gt0-rc');
        assert.equal(xeRead(`${GT('gt1')}/gtidle/name`).trim(), 'gt1-mc');

        // and the policy limits are the render GT's own, not the GPU's
        assert.equal(parseSysfsNumber(xeRead(`${GT('gt0')}/freq0/max_freq`)), 2500);
        assert.equal(parseSysfsNumber(xeRead(`${GT('gt0')}/freq0/min_freq`)), 900);
        assert.equal(parseSysfsNumber(xeRead(`${GT('gt1')}/freq0/max_freq`)), 1200);
    });

    test('the frequency read back from the hardware wins, and 0 falls back', () => {
        // Both read 900 under the load of the capture, so the precedence is pinned with
        // values that differ: act_freq reads 0 both while the GT sleeps and, as sampled
        // on this machine, while its idle_status is gt-c0
        assert.equal(intelFrequency(undefined, '900\n', '1700\n'), 1700);
        assert.equal(intelFrequency(undefined, '900\n', '0\n'), 900);
        assert.equal(intelFrequency(undefined, '900\n', ''), 900);
        // and a sample of intel_gpu_top still wins over both
        assert.equal(intelFrequency({ frequency: { actual: 450 } }, '900\n', '1700\n'), 450);
    });

    test('an idle GPU reads far lower once each counter is measured against itself', () => {
        const idle = ratesOf('idle0', 'idle1');
        const other = ratesOf('idle2', 'idle3');

        // Nothing was using the GPU, yet neither counter advanced at the rate of the
        // clock: the render GT's reached 0.859 of it and the media GT's 0.750, so read
        // as a fraction of the elapsed time they claim a 14% and a 25% busy GPU
        assert.ok(idle[GT('gt0')] > 0.85 && idle[GT('gt0')] < 0.87, `gt0 ${idle[GT('gt0')]}`);
        assert.ok(idle[GT('gt1')] > 0.74 && idle[GT('gt1')] < 0.76, `gt1 ${idle[GT('gt1')]}`);
        assert.equal(Math.round(intelActivityFromRates(idle, undefined)), 25);

        // The mark is what the hardware was seen to do, not the rate of the clock
        assert.deepEqual(intelMaxRates(undefined, other), other);

        // and measured against a mark learned from the other idle interval, the same
        // counters read a couple of per cent rather than 25: what is left is the two
        // intervals differing. The rate of a one second window is not a constant — it
        // varies by about a tenth across them, see the provenance above — so the mark
        // ends up at the top of that band and an idle GPU keeps reading a few per cent.
        const busy = intelActivityFromRates(idle, intelMaxRates(undefined, other));
        assert.ok(busy < 3, `calibrated idle ${busy}`);
    });

    test('the mark rises, is learned from below, and never from an impossible interval', () => {
        // It is a property of the counter, so it is kept across intervals
        assert.deepEqual(intelMaxRates({ gt0: 0.9 }, { gt0: 0.5 }), { gt0: 0.9 });
        assert.deepEqual(intelMaxRates({ gt0: 0.5 }, { gt0: 0.9 }), { gt0: 0.9 });
        assert.deepEqual(intelMaxRates(undefined, { gt0: 0.5 }), { gt0: 0.5 });
        // a GT that was not measured keeps the mark it had
        assert.deepEqual(intelMaxRates({ gt1: 0.7 }, { gt0: 0.5 }), { gt0: 0.5, gt1: 0.7 });

        // Nothing sleeps for longer than the interval, so an interval the clock says is
        // impossible is left out rather than learned: CLOCK_MONOTONIC stops across a
        // suspend and the counter of a GT that is only power gated does not. Both halves
        // are asked at the boundary, since a mis-measured interval is a rate slightly
        // over 1 rather than an absurd one, and a mark never comes back down.
        assert.deepEqual(intelResidencyRates({ gt0: 0 }, { gt0: 9000000 }, 1), {});
        assert.deepEqual(intelResidencyRates({ gt0: 0 }, { gt0: 1500 }, 1), {});
        assert.deepEqual(intelResidencyRates({ gt0: 0 }, { gt0: 1000 }, 1), { gt0: 1 });
        assert.deepEqual(intelMaxRates(undefined, { gt0: 4 }), {});
        assert.deepEqual(intelMaxRates(undefined, { gt0: 1.5 }), {});
        assert.deepEqual(intelMaxRates(undefined, { gt0: 1 }), { gt0: 1 });

        // A rate measured while the GT was busy is not what its counter does when it is
        // asleep, so it is not learned at all: taken as the asleep rate it would measure
        // the GT against itself and report a saturated GPU as an idle one
        assert.deepEqual(intelMaxRates(undefined, { gt0: 0.078, gt1: 0 }), {});
        assert.deepEqual(intelMaxRates({ gt0: 0.9 }, { gt0: 0.078 }), { gt0: 0.9 });

        // and a mark recorded below the rate being measured reports no activity rather
        // than a negative one
        assert.equal(intelActivityFromRates({ gt0: 0.9 }, { gt0: 0.5 }), 0);

        // A mark that could not be an asleep rate is ignored where it is used as well as
        // where it would be learned, so neither half can report a busy GT as an idle one
        assert.equal(intelActivityFromRates({ gt0: 0.078 }, { gt0: 0.078 }), 100 * (1 - 0.078));
        assert.equal(intelActivityFromRates({ gt0: 0 }, { gt0: 0 }), 100);
    });

    test('a GPU that was busy for every interval seen is not reported as an idle one', () => {
        // Nothing has been seen asleep yet, so there is no mark to calibrate against and
        // the counters are read as though they kept up with the clock. The media GT's
        // does not advance at all under a decode, so a mark taken from it would be 0 and
        // the GT would be measured against itself.
        const load = ratesOf('load0', 'load1');
        const marked = intelMaxRates(undefined, load);
        assert.deepEqual(marked, {});

        const busy = intelActivityFromRates(load, marked);
        assert.equal(busy, 100);
        assert.equal(Number.isNaN(busy), false);

        // and the render GT on its own reads the uncalibrated 92%, not 0%
        const render = intelActivityFromRates(
            { [GT('gt0')]: load[GT('gt0')] },
            intelMaxRates(undefined, { [GT('gt0')]: load[GT('gt0')] })
        );
        assert.ok(render > 92 && render < 93, `render ${render}`);
    });

    test('the busiest GT is the activity of the GPU, not the render one alone', () => {
        const load = ratesOf('load0', 'load1');
        const idle = ratesOf('idle0', 'idle1');

        // Three VAAPI encodes: the media GT did not sleep at all, the render GT a little
        assert.equal(load[GT('gt1')], 0);
        assert.ok(load[GT('gt0')] > 0.07 && load[GT('gt0')] < 0.08, `gt0 ${load[GT('gt0')]}`);

        const busy = intelActivityFromRates(load, idle);
        assert.equal(busy, 100);
        // the render GT alone would have reported nine tenths of that
        const render = intelActivityFromRates(
            { [GT('gt0')]: load[GT('gt0')] },
            { [GT('gt0')]: idle[GT('gt0')] }
        );
        assert.ok(render > 90 && render < 91, `render ${render}`);
    });

    test('a counter that runs backwards is left out, and one that stalls is a busy GT', () => {
        const before = residencies('idle0');
        const after = residencies('idle1');

        assert.deepEqual(intelResidencyRates(undefined, after, 1), {});
        assert.deepEqual(intelResidencyRates(before, after, 0), {});
        assert.deepEqual(intelResidencyRates(after, before, 1), {});
        assert.equal(intelActivityFromRates({}, undefined), undefined);

        // backwards for one GT, forwards for the other: one bad counter does not take
        // the GTs beside it with it
        assert.deepEqual(intelResidencyRates({ gt0: 10, gt1: 0 }, { gt0: 5, gt1: 500 }, 1), {
            gt1: 0.5,
        });

        // and a delta longer than the interval is no activity, not a negative one
        assert.equal(intelActivityFromRc6(0, 2000, 1), 0);
        assert.equal(intelActivityFromRc6(2000, 0, 1), undefined);
        assert.equal(intelActivityFromRc6(0, 500, 1), 50);

        // A counter that did not move at all is a GT that never slept, which is how the
        // media GT reports a saturated engine, so it is kept rather than left out
        assert.deepEqual(intelResidencyRates({ gt1: 7 }, { gt1: 7 }, 1), { gt1: 0 });
        assert.equal(intelActivityFromRates({ gt1: 0 }, { gt1: 0.75 }), 100);
    });

    test('the readings that do not depend on the driver are unchanged', () => {
        const meminfo = new URL('fixtures/proc-meminfo-pantherlake', import.meta.url);
        assert.equal(parseMemTotal(readFileSync(meminfo, 'utf8')), 32409652 * 1024);

        // The integrated GPU is the one that shares the CPU package, by its PCI address,
        // and the hwmon the monitor reads for it is the CPU package's, not the GPU's own
        assert.equal(isIntegratedIntelGpu(PDEV), true);
        assert.equal(isIntegratedIntelGpu('0000:03:00.0'), false);
        assert.equal(xeRead('class/hwmon/hwmon5/name').trim(), 'coretemp');
        assert.equal(xeRead('class/hwmon/hwmon5/temp1_label').trim(), 'Package id 0');
        assert.equal(parseSysfsNumber(xeRead('class/hwmon/hwmon5/temp1_input')) / 1000, 90);

        // Power is the energy counter's delta over the interval, in watts, and a
        // counter that wrapped is no reading
        assert.deepEqual(intelPower(undefined, 0, 2000000, 2), { value: 1, unit: 'W' });
        assert.equal(intelPower(undefined, 100, 50, 1), undefined);
        assert.equal(intelPower(undefined, undefined, 50, 1), undefined);
        assert.deepEqual(intelPower({ power: { GPU: 3.456 } }, 0, 0, 1), {
            value: 3.46,
            unit: 'W',
        });

        // and a sample of intel_gpu_top is cut out of its endless array
        assert.match('},', INTEL_SAMPLE_FLUSH);
        assert.deepEqual(parseIntelGpuSample('[{"power":{"GPU":1}},'), { power: { GPU: 1 } });
        assert.deepEqual(parseIntelGpuSample(',{"rc6":{"value":5}}'), { rc6: { value: 5 } });
        assert.equal(parseIntelGpuSample('"not an object"'), undefined);
    });
});

describe(`Intel GPU on ${HARDWARE}, DRM fdinfo`, { concurrency: false }, () => {
    const t0 = fdinfoScan('t0');
    const t1 = fdinfoScan('t1');

    // Δcycles / Δtotal_cycles, the ratio gputop takes, per client of the capture
    const shell = (1474013 / 39757094) * 100; // gnome-shell, render
    const xwayland = (571611 / 39604602) * 100; // Xwayland, render
    const gears = (218521 / 39511071) * 100; // glxgears, render
    const video = [
        (13177887 / 39551379) * 100,
        (13146836 / 39524824) * 100,
        (13107508 / 39516857) * 100,
    ]; // the three VAAPI encodes
    const enhance = [
        (2288756 / 39551379) * 100,
        (2245877 / 39524824) * 100,
        (2408274 / 39516857) * 100,
    ]; // which also drive the enhancement engine

    test('the raw files are what the scan hands over', () => {
        const encode = t1.get('ffmpeg-3330835-3');
        assert.equal(encode.pid, 3330835);
        assert.match(encode.content, /^drm-driver:\txe$/m);
        assert.match(encode.content, /^drm-pdev:\t0000:00:02\.0$/m);
        assert.match(encode.content, /^drm-cycles-vcs:\t\d+$/m);
        assert.match(encode.content, /^drm-resident-gtt:\t273580 KiB$/m);
        // every class of the kernel, for every client, whether it used it or not
        assert.equal(encode.content.match(/^drm-cycles-/gm).length, 5);
    });

    test('two scans make a sample the intel_gpu_top helpers take as they are', () => {
        const sample = intelFdinfoSample(t0, t1, PDEV);

        // The engine is the sum over the clients, in the order intel_gpu_top lists them
        assert.deepEqual(Object.keys(sample.engines), [
            'Render/3D',
            'Blitter',
            'Video',
            'VideoEnhance',
            'Compute',
        ]);
        assert.equal(sample.engines['Render/3D'].busy, shell + xwayland + gears);
        assert.equal(sample.engines.Video.busy, video[0] + video[1] + video[2]);
        assert.equal(sample.engines.VideoEnhance.busy, enhance[0] + enhance[1] + enhance[2]);
        assert.equal(sample.engines.Blitter.busy, 0);
        assert.equal(sample.engines.Compute.busy, 0);

        // Six processes: the compositor holds two clients, two descriptors each, and is
        // counted once; the three encodes are three processes of their own
        assert.equal(Object.keys(sample.clients).length, 6);
        const compositor = sample.clients['2765'];
        assert.equal(compositor.name, 'gnome-shell');
        assert.equal(compositor['engine-classes']['Render/3D'].busy, String(shell));
        assert.equal(compositor.memory.gtt.resident, String(1421928 * 1024));

        // and the memory of the GPU is what its clients hold, in the one region xe uses
        assert.deepEqual(intelVram(sample), {
            used: 2371379200,
            regions: [{ name: 'gtt', used: 2371379200 }],
        });
    });

    test('the order the descriptors were read in does not move a client', () => {
        // A client open more than once is counted once, and which process it lands on
        // has to be the same every scan or its row would move on its own
        const reversed = snapshot => fdinfoScan(snapshot, files => [...files].reverse());
        assert.deepEqual(
            intelFdinfoSample(reversed('t0'), reversed('t1'), PDEV),
            intelFdinfoSample(t0, t1, PDEV)
        );
    });

    test('the engines of a fdinfo sample never stand in for the whole GPU', () => {
        const sample = intelFdinfoSample(t0, t1, PDEV);
        const render = shell + xwayland + gears;

        // Taken on their own the engines say the GPU is 5.7% busy, because that is all
        // the clients this user may read add up to, while the GT itself never slept
        assert.equal(intelActivity(sample, undefined).GFX, render);

        const activity = intelActivity(sample, 100, true);
        assert.equal(activity.GFX, 100);
        // and the engines are still reported, as the breakdown they are
        assert.equal(activity.pipes.length, 5);
        assert.equal(activity.pipes[0].percent, render);

        // With no residency to prefer the engines are all there is, so they are used
        assert.equal(intelActivity(sample, undefined, true).GFX, render);
        assert.deepEqual(intelActivity(undefined, undefined, true), { pipes: [] });
    });

    test('a multi instance engine class is divided by its capacity, then clamped', () => {
        // Not reachable from this capture: xe prints the capacity only for a class that
        // has more than one instance, and Panther Lake has none, so the divisor is 1
        // throughout. This is the Arc shape, four compute instances all busy, which
        // gputop reports as 100% and not as 25%.
        const scan = (cycles, total) =>
            new Map([
                [
                    'ccs',
                    {
                        pid: 1,
                        name: 'compute',
                        content: [
                            `drm-pdev:\t${PDEV}`,
                            'drm-client-id:\t1',
                            `drm-cycles-ccs:\t${cycles}`,
                            `drm-total-cycles-ccs:\t${total}`,
                            'drm-engine-capacity-ccs:\t4',
                        ].join('\n'),
                    },
                ],
            ]);

        const saturated = intelFdinfoSample(scan(0, 0), scan(4000, 1000), PDEV);
        assert.equal(saturated.engines.Compute.busy, 100);
        // and half of them busy is half of the class, not an eighth of it
        const half = intelFdinfoSample(scan(0, 0), scan(2000, 1000), PDEV);
        assert.equal(half.engines.Compute.busy, 50);
    });

    test('a process holding two busy clients of one class is still at most 100%', () => {
        // The compositor holds two clients of this GPU, and a browser holds one per
        // renderer: their percentages are summed into the process, which cannot report
        // more of an engine than there is
        const scan = (cycles, total) =>
            new Map(
                [1, 2].map(id => [
                    `c${id}`,
                    {
                        pid: 7,
                        name: 'two-clients',
                        content: [
                            `drm-pdev:\t${PDEV}`,
                            `drm-client-id:\t${id}`,
                            `drm-cycles-rcs:\t${cycles}`,
                            `drm-total-cycles-rcs:\t${total}`,
                        ].join('\n'),
                    },
                ])
            );

        const sample = intelFdinfoSample(scan(0, 0), scan(600, 1000), PDEV);
        assert.equal(sample.clients['7']['engine-classes']['Render/3D'].busy, '100');
        assert.equal(sample.engines['Render/3D'].busy, 100);
    });

    test('a counter that went backwards between two scans is not an engine reading', () => {
        // A client id the kernel handed to another process, or a counter that reset
        const scan = (cycles, total) =>
            new Map([
                [
                    'a',
                    {
                        pid: 9,
                        name: 'reset',
                        content: [
                            `drm-pdev:\t${PDEV}`,
                            'drm-client-id:\t4',
                            `drm-cycles-rcs:\t${cycles}`,
                            `drm-total-cycles-rcs:\t${total}`,
                            'drm-resident-gtt:\t8 KiB',
                        ].join('\n'),
                    },
                ],
            ]);

        // the time moved on, the cycles of the client did not
        const sample = intelFdinfoSample(scan(5000, 0), scan(100, 1000), PDEV);
        assert.deepEqual(sample.engines, {});
        // the memory it holds is still a reading
        assert.equal(sample.clients['9'].memory.gtt.resident, String(8 * 1024));
    });

    test('a descriptor of another GPU, or of no GPU at all, is not a client', () => {
        const other = new Map([['x', { pid: 1, name: 'x', content: 'pos:\t0\nflags:\t0100002' }]]);
        assert.deepEqual(intelFdinfoSample(other, other, PDEV).clients, {});
        assert.deepEqual(intelFdinfoSample(t0, t1, '0000:03:00.0').clients, {});
        assert.equal(intelVram(intelFdinfoSample(other, other, PDEV)), undefined);
    });

    test('the PCI address of a client is matched whatever case it is written in', () => {
        // The kernel writes it lowercase and so does lspci, so an address with a hex
        // letter in it is the only one that can tell a case sensitive match apart
        const scan = pdev =>
            new Map([
                [
                    'a',
                    {
                        pid: 3,
                        name: 'card',
                        content: [
                            `drm-pdev:\t${pdev}`,
                            'drm-client-id:\t9',
                            'drm-resident-vram0:\t4 KiB',
                        ].join('\n'),
                    },
                ],
            ]);

        const clients = (written, asked) => {
            const scanned = scan(written);
            return Object.keys(intelFdinfoSample(scanned, scanned, asked).clients).length;
        };
        assert.equal(clients('0000:0a:00.0', '0000:0A:00.0'), 1);
        assert.equal(clients('0000:0A:00.0', '0000:0a:00.0'), 1);
    });

    test('a client seen for the first time reports its memory, and no activity', () => {
        const sample = intelFdinfoSample(new Map(), t1, PDEV);
        assert.deepEqual(sample.engines, {});
        // its resident memory needs no previous scan to be a reading
        assert.equal(intelVram(sample).used, 2371379200);
        assert.equal(sample.clients['2765']['engine-classes']['Render/3D'], undefined);
    });
});
