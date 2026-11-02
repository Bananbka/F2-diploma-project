import {
    Bell,
    Book,
    Bookmark,
    Briefcase,
    Camera,
    Car,
    Code,
    Coffee,
    Dumbbell,
    Film,
    Flag,
    Folder as FolderIcon,
    Gamepad2,
    Gift,
    Globe,
    GraduationCap,
    Heart,
    House,
    Image,
    Lightbulb,
    Lock,
    LucideIconData,
    MapPin,
    MessageCircle,
    Moon,
    Music,
    Newspaper,
    Palette,
    Phone,
    Plane,
    Rocket,
    Shield,
    ShoppingCart,
    Star,
    Sun,
    Tag,
    Trophy,
    User,
    Users,
    Wallet,
    Wrench,
    Zap,
} from 'lucide-angular';

/** What a folder shows when it has no icon, or one this client does not know. */
export const DEFAULT_FOLDER_ICON: LucideIconData = FolderIcon;

/**
 * The icons a folder can carry, keyed by the kebab-case lucide name the API stores. The stored
 * value is only a name, so an icon removed from this list later (or added by a newer client)
 * degrades to the default rather than breaking.
 */
export const FOLDER_ICONS: Readonly<Record<string, LucideIconData>> = {
    briefcase: Briefcase,
    home: House,
    star: Star,
    heart: Heart,
    users: Users,
    user: User,
    book: Book,
    'graduation-cap': GraduationCap,
    code: Code,
    'gamepad-2': Gamepad2,
    music: Music,
    camera: Camera,
    'shopping-cart': ShoppingCart,
    plane: Plane,
    car: Car,
    coffee: Coffee,
    bell: Bell,
    bookmark: Bookmark,
    flag: Flag,
    globe: Globe,
    lock: Lock,
    'map-pin': MapPin,
    'message-circle': MessageCircle,
    newspaper: Newspaper,
    phone: Phone,
    tag: Tag,
    wallet: Wallet,
    zap: Zap,
    sun: Sun,
    moon: Moon,
    gift: Gift,
    film: Film,
    image: Image,
    dumbbell: Dumbbell,
    palette: Palette,
    rocket: Rocket,
    shield: Shield,
    wrench: Wrench,
    lightbulb: Lightbulb,
    trophy: Trophy,
};

export interface FolderIconOption {
    /** The stored name, or null for the default. */
    name: string | null;
    data: LucideIconData;
}

/** The picker's cells: the default first, then every curated icon. */
export const FOLDER_ICON_OPTIONS: readonly FolderIconOption[] = [
    { name: null, data: DEFAULT_FOLDER_ICON },
    ...Object.entries(FOLDER_ICONS).map(([name, data]) => ({ name, data })),
];

export function folderIconFor(name: string | null | undefined): LucideIconData {
    return (name && Object.hasOwn(FOLDER_ICONS, name) ? FOLDER_ICONS[name] : null) ?? DEFAULT_FOLDER_ICON;
}
