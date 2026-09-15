/**
 * Drop this into your RN repo as jest.setup.js and reference it from
 * jest.config.js via setupFilesAfterEach.
 *
 * Why this file exists: the single most common reason a generated RN test is
 * deleted by the developer is that it never ran — a native module threw on
 * import. Centralising the mocks here means the engine's prompt does not have
 * to re-invent them per file, and the generated tests stay short.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
require('react-native-gesture-handler/jestSetup');

// ---- Reanimated ------------------------------------------------------------
jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  Reanimated.default.call = () => {};
  return Reanimated;
});

// ---- Navigation ------------------------------------------------------------
const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockReplace = jest.fn();

jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({
    navigate: mockNavigate,
    goBack: mockGoBack,
    replace: mockReplace,
    addListener: jest.fn(() => jest.fn()),
    setOptions: jest.fn(),
  }),
  useRoute: () => ({ params: {}, key: 'test', name: 'TestScreen' }),
  useIsFocused: () => true,
  useFocusEffect: (cb) => cb(),
}));

// ---- Secure storage --------------------------------------------------------
// Note the asymmetry: AsyncStorage gets a working in-memory fake, Keychain gets
// an explicit mock. If a file writes a token through AsyncStorage, the test will
// pass — which is exactly why that is a Checkmarx/Sonar finding and not
// something the test suite can catch for you.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('react-native-keychain', () => ({
  setGenericPassword: jest.fn(async () => true),
  getGenericPassword: jest.fn(async () => ({ username: 'u', password: 'stub-token' })),
  resetGenericPassword: jest.fn(async () => true),
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly' },
  ACCESS_CONTROL: { BIOMETRY_CURRENT_SET: 'BiometryCurrentSet' },
}));

jest.mock('react-native-encrypted-storage', () => ({
  setItem: jest.fn(async () => undefined),
  getItem: jest.fn(async () => null),
  removeItem: jest.fn(async () => undefined),
  clear: jest.fn(async () => undefined),
}));

// ---- Device / permissions / analytics --------------------------------------
jest.mock('react-native-device-info', () => ({
  getUniqueId: jest.fn(async () => 'test-device-id'),
  getVersion: jest.fn(() => '1.0.0'),
  isEmulator: jest.fn(async () => true),
}));

jest.mock('react-native-permissions', () => require('react-native-permissions/mock'));

jest.mock('@react-native-firebase/analytics', () => () => ({
  logEvent: jest.fn(async () => undefined),
  setUserProperty: jest.fn(async () => undefined),
}));

// ---- Global hygiene --------------------------------------------------------
beforeEach(() => {
  jest.clearAllMocks();
});

// Surface unhandled rejections as test failures instead of silent passes.
process.on('unhandledRejection', (reason) => {
  throw reason;
});

global.__RNQA_NAV_MOCKS__ = { mockNavigate, mockGoBack, mockReplace };
