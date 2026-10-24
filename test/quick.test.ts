import { describe, expect, it } from 'vitest';
import { judgeStep, quickSteps } from '../electron/policy';

describe('instant commands (no brain call)', () => {
  it('player', () => {
    expect(quickSteps('pause')).toEqual([{ tool: 'media.control', args: { action: 'pause' } }]);
    expect(quickSteps('Hey, resume the video')).toEqual([{ tool: 'media.control', args: { action: 'resume' } }]);
    expect(quickSteps('volume 30%')).toEqual([{ tool: 'media.control', args: { action: 'volume', level: 30 } }]);
  });

  it('screen dimming, never the lights', () => {
    expect(quickSteps('dim the screen')).toEqual([{ tool: 'screen.dim', args: { level: 50 } }]);
    expect(quickSteps('dim my screen to 30%')).toEqual([{ tool: 'screen.dim', args: { level: 30 } }]);
    expect(quickSteps('brighten the screen')).toEqual([{ tool: 'screen.dim', args: { level: 0 } }]);
    expect(quickSteps('dim the lights')).toBeNull();
  });

  it('play X on YouTube / YouTube Music', () => {
    const play = { tool: 'media.play', args: { ref: '$prev' } };
    expect(quickSteps('Play Tame Impala on YouTube Music.')).toEqual([{ tool: 'media.search', args: { query: 'tame impala', kind: 'song' } }, play]);
    expect(quickSteps('play lo-fi beats on youtube')).toEqual([{ tool: 'media.search', args: { query: 'lo fi beats', kind: 'video' } }, play]);
    expect(quickSteps('play some tame impala on youtube music')![0].args.query).toBe('tame impala');
    expect(quickSteps('play something on youtube music')).toBeNull();
    expect(quickSteps('play some music on youtube music')).toBeNull();
  });

  it('real screen brightness', () => {
    const b = (level: unknown) => [{ tool: 'screen.brightness', args: { level } }];
    expect(quickSteps('reduce the brightness of my screen')).toEqual(b('down'));
    expect(quickSteps('turn up the brightness')).toEqual(b('up'));
    expect(quickSteps('set brightness to 30%')).toEqual(b(30));
    expect(quickSteps('change the brightness of my screen to 70')).toEqual(b(70));
    expect(quickSteps('brightness 2')).toEqual(b(5));
    expect(quickSteps('max brightness')).toEqual(b(100));
    expect(quickSteps('make the screen darker')).toEqual(b('down'));
    expect(quickSteps('reduce the brightness of the lights')).toBeNull();
    expect(judgeStep(b('down')[0] as never, { userText: 'x' }).mode).toBe('auto');
  });

  it('timers and notes', () => {
    expect(quickSteps('set a timer for 10 minutes')).toEqual([{ tool: 'timer.set', args: { minutes: 10, label: 'Timer' } }]);
    expect(quickSteps('remind me in 2 hours to call mom')).toEqual([{ tool: 'timer.set', args: { minutes: 120, label: 'call mom' } }]);
    expect(quickSteps('take a note buy milk')).toEqual([{ tool: 'note.add', args: { text: 'buy milk' } }]);
    expect(quickSteps('Note: call the plumber.')).toEqual([{ tool: 'note.add', args: { text: 'call the plumber.' } }]);
  });

  it('real requests still go to the brain', () => {
    for (const t of ['open my resume', 'play something I like', 'find the pricing page on stripe', 'summarize my screen', 'pause and dim the lights']) expect(quickSteps(t), t).toBeNull();
  });

  it('local steps still pass the policy check', () => {
    for (const t of ['pause', 'dim the screen', 'set a timer for 5 minutes', 'take a note hi there']) expect(judgeStep(quickSteps(t)![0], { userText: t }).mode, t).toBe('auto');
  });
});

describe('search then do it, no extra round', () => {
  it('adds the open or the play the model left out', async () => {
    const { addOpen } = await import('../electron/policy');
    const file = [{ tool: 'file.search' as const, args: { nameHints: ['dlc', 'assignment'] } }];
    expect(addOpen(file, 'search for my DLC assignment and open it in my browser').at(-1)).toEqual({ tool: 'file.open', args: { ref: '$prev', browser: true } });
    expect(addOpen(file, 'open the DLC assignment').at(-1)).toEqual({ tool: 'file.open', args: { ref: '$prev' } });
    const media = [{ tool: 'media.search' as const, args: { query: 'lofi', kind: 'song' } }];
    expect(addOpen(media, 'play some music on YouTube Music').at(-1)).toEqual({ tool: 'media.play', args: { ref: '$prev' } });
    const opened = [...file, { tool: 'file.open' as const, args: { ref: '$prev' } }];
    expect(addOpen(opened, 'open it in chrome').at(-1)).toEqual({ tool: 'file.open', args: { ref: '$prev', browser: true } });
  });
});
