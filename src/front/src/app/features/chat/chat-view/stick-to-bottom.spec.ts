import { StickToBottom } from './stick-to-bottom';

describe('StickToBottom', () => {
    let host: HTMLDivElement;
    let content: HTMLDivElement;
    let stick: StickToBottom;

    const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const grow = async (height: number) => {
        content.style.height = `${height}px`;
        await raf();
        await raf();
        await raf();
    };
    const userScrollTo = (top: number) => {
        host.scrollTop = top;
        stick.onScroll();
    };

    beforeEach(async () => {
        host = document.createElement('div');
        host.style.cssText = 'height:200px;overflow-y:auto;position:fixed;top:0;left:0;width:200px';
        content = document.createElement('div');
        content.style.height = '300px';
        host.appendChild(content);
        document.body.appendChild(host);
        stick = new StickToBottom(host);
        stick.attach();
        await grow(300);
    });

    afterEach(() => {
        stick.detach();
        host.remove();
    });

    it('stays at the bottom when content grows while pinned', async () => {
        stick.scrollToBottomNow();
        stick.onScroll();
        await grow(900);
        expect(host.scrollHeight - host.scrollTop - host.clientHeight).toBeLessThan(2);
    });

    it('does not move when the reader has scrolled up', async () => {
        userScrollTo(0);
        expect(stick.isPinned).toBeFalse();
        await grow(900);
        expect(host.scrollTop).toBe(0);
    });

    it('re-arms when the reader returns near the bottom', async () => {
        userScrollTo(0);
        await grow(900);
        userScrollTo(host.scrollHeight - host.clientHeight - 10);
        expect(stick.isPinned).toBeTrue();
        await grow(1200);
        expect(host.scrollHeight - host.scrollTop - host.clientHeight).toBeLessThan(2);
    });

    it('pins again after a reset, as when another chat opens', async () => {
        userScrollTo(0);
        stick.reset();
        await grow(900);
        expect(host.scrollHeight - host.scrollTop - host.clientHeight).toBeLessThan(2);
    });
});
