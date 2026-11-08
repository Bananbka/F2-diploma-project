import { HiddenViewId } from '../../core/models/appearance.model';
import { canHideView, DEFAULT_VIEWS, firstVisibleChatView, isHiddenSelection } from './default-views';

describe('default views', () => {
    it('lists the six built-in views in rail order, Contacts last', () => {
        expect(DEFAULT_VIEWS.map((v) => v.id)).toEqual(['all', 'direct', 'groups', 'channels', 'unread', 'contacts']);
    });

    it('lets Contacts always be hidden', () => {
        expect(canHideView(['all', 'direct', 'groups', 'channels'], 'contacts')).toBeTrue();
    });

    it('refuses to hide the last visible chat view', () => {
        const hidden: HiddenViewId[] = ['all', 'direct', 'groups', 'channels'];
        expect(canHideView(hidden, 'unread')).toBeFalse();
        expect(canHideView(['all'], 'direct')).toBeTrue();
    });

    it('falls back to the first chat view that is still visible', () => {
        expect(firstVisibleChatView([])).toBe('all');
        expect(firstVisibleChatView(['all', 'direct'])).toBe('group');
        expect(isHiddenSelection(['direct'], 'direct')).toBeTrue();
        expect(isHiddenSelection(['direct'], 'all')).toBeFalse();
        expect(isHiddenSelection(['direct'], 'folder:abc')).toBeFalse();
    });
});
