const _ = require('lodash');
const util = require('util');
const logger = require('./utils/logger');
const Deferred = require('./utils/Deferred');
const log = logger.child({ __filename });
const Device = require('./devices/Device');
const IosDriver = require('./devices/drivers/ios/IosDriver');
const SimulatorDriver = require('./devices/drivers/ios/SimulatorDriver');
const EmulatorDriver = require('./devices/drivers/android/EmulatorDriver');
const AttachedAndroidDriver = require('./devices/drivers/android/AttachedAndroidDriver');
const DetoxRuntimeError = require('./errors/DetoxRuntimeError');
const AsyncEmitter = require('./utils/AsyncEmitter');
const MissingDetox = require('./utils/MissingDetox');
const configuration = require('./configuration');
const Client = require('./client/Client');
const DetoxServer = require('./server/DetoxServer');
const URL = require('url').URL;
const ArtifactsManager = require('./artifacts/ArtifactsManager');

const DEVICE_CLASSES = {
  'ios.simulator': SimulatorDriver,
  'ios.none': IosDriver,
  'android.emulator': EmulatorDriver,
  'android.attached': AttachedAndroidDriver,
};

const _initHandle = Symbol('_initHandle');
const _assertNoPendingInit = Symbol('_assertNoPendingInit');

class Detox {
  constructor(config) {
    log.trace(
      { event: 'DETOX_CREATE', config },
      'created a Detox instance with config:\n%j',
      config
    );

    this[_initHandle] = null;

    const {artifactsConfig, deviceConfig, session} = config;

    this._artifactsConfig = artifactsConfig;
    this._deviceConfig = deviceConfig;
    this._userSession = deviceConfig.session || session;
    this._client = null;
    this._server = null;
    this._artifactsManager = null;
    this._eventEmitter = new AsyncEmitter({
      events: [
        'bootDevice',
        'beforeShutdownDevice',
        'shutdownDevice',
        'beforeTerminateApp',
        'terminateApp',
        'beforeUninstallApp',
        'beforeLaunchApp',
        'launchApp',
        'appReady',
        'createExternalArtifact',
      ],
      onError: this._onEmitError.bind(this),
    });

    this.device = null;
  }

  init(userParams) {
    if (!this[_initHandle]) {
      this[_initHandle] = new Deferred();

      const { resolve, reject } = this[_initHandle];
      this._doInit(userParams).then(resolve, reject);
    }

    return this[_initHandle].promise;
  }

  async cleanup() {
    await this[_assertNoPendingInit]().catch(_.noop);

    if (this._artifactsManager) {
      await this._artifactsManager.onBeforeCleanup();
      this._artifactsManager = null;
    }

    if (this._client) {
      this._client.dumpPendingRequests();
      await this._client.cleanup();
      this._client = null;
    }

    if (this.device) {
      await this.device._cleanup();
    }

    if (this._server) {
      await this._server.close();
      this._server = null;
    }

    this.device = null;
  }

  async beforeEach(testSummary) {
    await this[_assertNoPendingInit]();

    this._validateTestSummary(testSummary);
    this._logTestRunCheckpoint('DETOX_BEFORE_EACH', testSummary);
    await this._dumpUnhandledErrorsIfAny({
      pendingRequests: false,
      testName: testSummary.fullName,
    });
    await this._artifactsManager.onTestStart(testSummary);
  }

  async afterEach(testSummary) {
    await this[_assertNoPendingInit]();

    this._validateTestSummary(testSummary);
    this._logTestRunCheckpoint('DETOX_AFTER_EACH', testSummary);
    await this._artifactsManager.onTestDone(testSummary);
    await this._dumpUnhandledErrorsIfAny({
      pendingRequests: testSummary.timedOut,
      testName: testSummary.fullName,
    });
  }

  async suiteStart(suite) {
    await this._artifactsManager.onSuiteStart(suite);
  }

  async suiteEnd(suite) {
    await this._artifactsManager.onSuiteEnd(suite);
  }

  async _doInit(userParams) {
    const sessionConfig = await this._getSessionConfig();
    const params = {
      launchApp: true,
      initGlobals: true,
      ...userParams,
    };

    if (!this._userSession) {
      this._server = new DetoxServer({
        log: logger,
        port: new URL(sessionConfig.server).port,
      });
    }

    this._client = new Client(sessionConfig);
    this._client.setNonresponsivenessListener(this._onNonresnponsivenessEvent.bind(this));
    await this._client.connect();

    let DeviceDriverClass = DEVICE_CLASSES[this._deviceConfig.type];
    if (!DeviceDriverClass) {
      try {
        DeviceDriverClass = require(this._deviceConfig.type);
      } catch (e) {
        // noop, if we don't find a module to require, we'll hit the unsupported error below
      }
    }
    if (!DeviceDriverClass) {
      throw new Error(`'${this._deviceConfig.type}' is not supported`);
    }

    const deviceDriver = new DeviceDriverClass({
      client: this._client,
      emitter: this._eventEmitter,
    });

    Object.assign(this, deviceDriver.matchers);

    this.device = new Device({
      deviceConfig: this._deviceConfig,
      emitter: this._eventEmitter,
      deviceDriver,
      sessionConfig,
    });

    if (params.initGlobals) {
      Object.assign(global, {
        ...deviceDriver.matchers,
        device: this.device,
      });
    }

    this._artifactsManager = new ArtifactsManager(this._artifactsConfig);
    this._artifactsManager.subscribeToDeviceEvents(this._eventEmitter);
    this._artifactsManager.registerArtifactPlugins(deviceDriver.declareArtifactPlugins());

    await this.device.prepare(params);
    return this;
  }

  [_assertNoPendingInit]() {
    const handle = this[_initHandle];
    if (!handle) {
      return Promise.resolve();
    }

    if (handle.status === Deferred.PENDING) {
      handle.reject(
        new DetoxRuntimeError({
          message: 'Aborted detox.init() execution, and now running detox.cleanup()',
          hint: 'Most likely, your test runner is tearing down the suite due to the timeout error'
        })
      );
    }

    return handle.promise;
  }

  _logTestRunCheckpoint(event, { status, fullName }) {
    log.trace({ event, status }, `${status} test: ${JSON.stringify(fullName)}`);
  }

  _validateTestSummary(testSummary) {
    if (!_.isPlainObject(testSummary)) {
      throw new DetoxRuntimeError({
        message: `Invalid test summary was passed to detox.beforeEach(testSummary)` +
          '\nExpected to get an object of type: { title: string; fullName: string; status: "running" | "passed" | "failed"; }',
        hint: 'Maybe you are still using an old undocumented signature detox.beforeEach(string, string, string) in init.js ?' +
          '\nSee the article for the guidance: ' +
          'https://github.com/wix/detox/blob/master/docs/APIRef.TestLifecycle.md',
        debugInfo: `testSummary was: ${util.inspect(testSummary)}`,
      });
    }

    switch (testSummary.status) {
      case 'running':
      case 'passed':
      case 'failed':
        break;
      default:
        throw new DetoxRuntimeError({
          message: `Invalid test summary status was passed to detox.beforeEach(testSummary). Valid values are: "running", "passed", "failed"`,
          hint: "It seems like you've hit a Detox integration issue with a test runner. You are encouraged to report it in Detox issues on GitHub.",
          debugInfo: `testSummary was: ${JSON.stringify(testSummary, null, 2)}`,
        });
    }
  }

  _onNonresnponsivenessEvent(params) {
    const message = [
      'Application nonresponsiveness detected!',
      'On Android, this could imply an ANR alert, which evidently causes tests to fail.',
      'Here\'s the native main-thread stacktrace from the device, to help you out (refer to device logs for the complete thread dump):',
      params.threadDump,
      'Refer to https://developer.android.com/training/articles/perf-anr for further details.'
    ].join('\n');

    log.warn({ event: 'APP_NONRESPONSIVE' }, message);
  }

  async _dumpUnhandledErrorsIfAny({ testName, pendingRequests }) {
    if (pendingRequests) {
      this._client.dumpPendingRequests({testName});
    }

    const pendingAppCrash = this._client.getPendingCrashAndReset();

    if (pendingAppCrash) {
      log.error({ event: 'APP_CRASH' }, `App crashed in test '${testName}', here's the native stack trace: \n${pendingAppCrash}`);
      await this.device.launchApp({ newInstance: true });
    }
  }

  async _getSessionConfig() {
    const session = this._userSession || await configuration.defaultSession();

    configuration.validateSession(session);

    return session;
  }

  _onEmitError({ error, eventName, eventObj }) {
    log.error(
      { event: 'EMIT_ERROR', fn: eventName },
      `Caught an exception in: emitter.emit("${eventName}", ${JSON.stringify(eventObj)})\n\n`,
      error
    );
  }
}

Detox.none = new MissingDetox();

module.exports = Detox;
