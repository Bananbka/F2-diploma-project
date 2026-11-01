import { avatarKindFor, chatTitle, groupInitials, initials } from './display';

describe('groupInitials', () => {
    it('takes the first letter of up to two words', () => {
        expect(groupInitials('Game night')).toBe('GN');
        expect(groupInitials('Weekend trip to Lviv')).toBe('WT');
        expect(groupInitials('family')).toBe('F');
    });

    it('ignores a leading # and other decoration', () => {
        expect(groupInitials('#general')).toBe('G');
        expect(groupInitials('# dev ops')).toBe('DO');
        expect(groupInitials('--- team ---')).toBe('T');
    });

    it('skips emoji when there are letters, and uses the emoji when there are none', () => {
        expect(groupInitials('🎮 Game night')).toBe('GN');
        expect(groupInitials('🎮')).toBe('🎮');
        expect(groupInitials('🎮🎲')).toBe('🎮');
    });

    it('handles non-Latin scripts and digits', () => {
        expect(groupInitials('Робоча група')).toBe('РГ');
        expect(groupInitials('2024 plans')).toBe('2P');
    });

    it('is empty when there is nothing to show, so the icon takes over', () => {
        expect(groupInitials('')).toBe('');
        expect(groupInitials('###')).toBe('');
        expect(groupInitials('   ')).toBe('');
    });
});

describe('initials', () => {
    it('keeps first and last for a person', () => {
        expect(initials('Ada Lovelace')).toBe('AL');
        expect(initials('Cher')).toBe('CH');
    });

    it('never splits an emoji or expands a capital', () => {
        expect(initials('🎮🎲 Club')).toBe('🎮C');
        expect(initials('🎮')).toBe('🎮');
        expect(initials('ßeta Ähm')).toBe('SÄ');
        expect(initials('ßa')).toBe('SA');
        expect(groupInitials('ßeta group')).toBe('SG');
    });

    it('handles digits-only and empty names', () => {
        expect(initials('2024')).toBe('20');
        expect(groupInitials('2024')).toBe('2');
        expect(initials('   ')).toBe('??');
    });
});

describe('avatarKindFor and chatTitle', () => {
    it('gives only groups and channels the group treatment', () => {
        expect(avatarKindFor('group')).toBe('group');
        expect(avatarKindFor('channel')).toBe('channel');
        expect(avatarKindFor('private')).toBe('person');
        expect(avatarKindFor(undefined)).toBe('person');
    });

    it('names a deleted peer and an untitled chat', () => {
        expect(chatTitle({ chat_type: 'private', title: 'Bob', peer_is_deleted: true })).toBe('Deleted user');
        expect(chatTitle({ chat_type: 'channel', title: null })).toBe('Channel');
        expect(chatTitle({ chat_type: 'group', title: null })).toBe('Untitled chat');
        expect(chatTitle({ chat_type: 'group', title: 'Team' })).toBe('Team');
        expect(chatTitle({ chat_type: 'group', title: '' })).toBe('Untitled chat');
        expect(chatTitle({ chat_type: 'channel', title: '   ' })).toBe('Channel');
    });
});
