import {showDialog} from '../../../actions/notifications';
import {DialogActions, DialogType, IDialogContent} from '../../../types/IDialog';
import { ComponentEx, connect, translate } from '../../../util/ComponentEx';
import { showError } from '../../../util/message';
import { setSafe } from '../../../util/storeHelper';
import Icon from '../../../views/Icon';
import { Button } from '../../../views/TooltipControls';
import { setActivator, setPath } from '../actions/settings';
import { IModActivator } from '../types/IModActivator';
import { IStatePaths } from '../types/IStateSettings';
import resolvePath, {PathKey} from '../util/resolvePath';
import supportedActivators from '../util/supportedActivators';

import * as Promise from 'bluebird';
import * as fs from 'fs-extra-promise';
import * as path from 'path';
import * as React from 'react';
import update = require('react-addons-update');
import {Alert, ControlLabel, FormControl, FormGroup,
        HelpBlock, InputGroup, Jumbotron, Modal, Panel} from 'react-bootstrap';

import { log } from '../../../util/log';

import * as _ from 'lodash';

interface IBaseProps {
  activators: IModActivator[];
}

interface IConnectedProps {
  paths: IStatePaths;
  gameMode: string;
  currentActivator: string;
  state: any;
}

interface IActionProps {
  onSetPath: (key: string, path: string) => void;
  onSetActivator: (id: string) => void;
  onShowDialog: (type: DialogType, title: string,
    content: IDialogContent, actions: DialogActions) => void;
  onShowError: (message: string, details: string | Error) => void;
}

interface IComponentState {
  paths: IStatePaths;
  busy: string;
  supportedActivators: IModActivator[];
}

type IProps = IBaseProps & IActionProps & IConnectedProps;

const nop = () => undefined;

class Settings extends ComponentEx<IProps, IComponentState> {
  private mPathChangeCBs: { [key: string]: (evt: any) => void } = {};
  private mBrowseCBs: { [key: string]: () => void } = {};

  constructor(props) {
    super(props);
    this.state = {
      paths: Object.assign(this.props.paths),
      busy: undefined,
      supportedActivators: [],
    };
  }

  public componentWillMount() {
    this.setState(update(this.state, {
      supportedActivators: { $set: this.supportedActivators() }
    }));
  }

  public componentDidUpdate(prevProps: IProps, prevState: IComponentState) {
    if ((this.props.gameMode !== prevProps.gameMode)
      || _.isEqual(this.props.paths, prevProps.paths)) {
      this.setState(update(this.state, {
        supportedActivators: { $set: this.supportedActivators() },
      }));
    }
  }

  public render(): JSX.Element {
    const { currentActivator, activators, t } = this.props;

    return (
      <form>
        <Panel footer={this.renderFooter()}>
        {this.renderPathCtrl(t('Base Path'), 'base')}
        {this.renderPathCtrl(t('Download Path'), 'download')}
        {this.renderPathCtrl(t('Install Path'), 'install')}
        <Modal show={this.state.busy !== undefined} onHide={nop}>
          <Modal.Body>
          <Jumbotron>
            <p><Icon name='spinner' pulse style={{ height: '32px', width: '32px' }} />
              {this.state.busy}</p>
          </Jumbotron>
          </Modal.Body>
        </Modal>
        </Panel>
        <ControlLabel>{ t('Activation Method') }</ControlLabel>
        <FormGroup validationState={ activators !== undefined ? undefined : 'error' }>
          { this.renderActivators(activators, currentActivator) }
        </FormGroup>
      </form>
    );
  }

  /**
   * return only those activators that are supported based on the current state
   *
   * @param {*} state
   * @returns {IModActivator[]}
   */
  private supportedActivators(): IModActivator[] {
    return supportedActivators(this.props.activators, this.props.state);
  }

  private pathsChanged() {
    return (this.props.paths.base !== this.state.paths.base)
        || (this.props.paths.download !== this.state.paths.download)
        || (this.props.paths.install !== this.state.paths.install);
  }

  private pathsAbsolute() {
    const { gameMode } = this.props;
    return path.isAbsolute(resolvePath('download', this.state.paths, gameMode))
        && path.isAbsolute(resolvePath('install', this.state.paths, gameMode));
  }

  private transferPath(pathKey: PathKey) {
    const { gameMode } = this.props;
    let oldPath = resolvePath(pathKey, this.props.paths, gameMode);
    let newPath = resolvePath(pathKey, this.state.paths, gameMode);

    return Promise.join(fs.statAsync(oldPath), fs.statAsync(newPath),
      (statOld: fs.Stats, statNew: fs.Stats) => {
        return Promise.resolve(statOld.dev === statNew.dev);
      })
      .then((sameVolume: boolean) => {
        if (sameVolume) {
          return fs.renameAsync(oldPath, newPath);
        } else {
          return fs.copyAsync(oldPath, newPath)
          .then(() => {
            return fs.removeAsync(oldPath);
          });
        }
      });
  }

  private applyPaths = () => {
    const { t, gameMode, onSetPath, onShowError } = this.props;
    let newInstallPath: string = resolvePath('install', this.state.paths, gameMode);
    let newDownloadPath: string = resolvePath('download', this.state.paths, gameMode);
    this.setState(setSafe(this.state, ['busy'], t('Moving')));
    return Promise.join(
      fs.ensureDirAsync(newInstallPath),
      fs.ensureDirAsync(newDownloadPath),
    )
      .then(() => {
        // ensure the destination files are empty
        return Promise.join(fs.readdirAsync(newInstallPath), fs.readdirAsync(newDownloadPath),
          (installFiles: string[], downloadFiles: string[]) => {
            return new Promise((resolve, reject) => {
              if (installFiles.length + downloadFiles.length > 0) {
                this.props.onShowDialog('info', 'Invalid Destination', {
                  message: 'The destination directory has to be empty',
                }, {
                    Ok: () => {
                      reject(null);
                    },
                  });
              } else {
                resolve();
              }
            });
          });
      })
      .then(() => {
        this.setState(setSafe(this.state, ['busy'], t('Moving download directory')));
        return this.transferPath('download');
      })
      .then(() => {
        this.setState(setSafe(this.state, ['busy'], t('Moving mod directory')));
        return this.transferPath('install');
      })
      .then(() => {
        onSetPath('base', this.state.paths.base);
        onSetPath('download', this.state.paths.download);
        onSetPath('install', this.state.paths.install);
        this.setState(setSafe(this.state, ['busy'], undefined));
      })
      .catch((err) => {
        this.setState(setSafe(this.state, ['busy'], undefined));
        if (err !== null) {
          onShowError('Failed to move directories', err);
        }
      })
      ;
  }

  private renderFooter() {
    const { t } = this.props;

    if (!this.pathsChanged()) {
      return null;
    }

    if (!this.pathsAbsolute()) {
      return (
        <Alert bsStyle='warning'>
        {t('Paths have to be absolute')}
        </Alert>
      );
    }

    return (
      <div className='button-group'>
        <Button
          id='btn-settings-apply'
          tooltip={t('Apply Changes. This will cause files to be moved to the new location.')}
          onClick={this.applyPaths}
        >
          {t('Apply')}
        </Button>
      </div>
    );
  }

  private renderPathCtrl(label: string, pathKey: PathKey): JSX.Element {
    const { t, gameMode } = this.props;
    let { paths } = this.state;
    if (this.mPathChangeCBs[pathKey] === undefined) {
      this.mPathChangeCBs[pathKey] = (evt) => this.changePathEvt(pathKey, evt);
    }
    if (this.mBrowseCBs[pathKey] === undefined) {
      this.mBrowseCBs[pathKey] = () => this.browsePath(pathKey);
    }
    return (
      <FormGroup>
      <ControlLabel>{label}</ControlLabel>
      <InputGroup>
        <FormControl
          value={paths[pathKey]}
          placeholder={label}
          onChange={this.mPathChangeCBs[pathKey]}
        />
        <InputGroup.Button>
          <Button
            id='move-base-path'
            tooltip={t('Browse')}
            onClick={this.mBrowseCBs[pathKey]}
          >
            <Icon name='folder-open' />
          </Button>
        </InputGroup.Button>
      </InputGroup>
      <HelpBlock>{ resolvePath(pathKey, paths, gameMode) }</HelpBlock>
      </FormGroup>
    );
  }

  private changePathEvt = (key: string, evt) => {
    let target: HTMLInputElement = evt.target as HTMLInputElement;
    this.changePath(key, target.value);
  }

  private changePath = (key: string, value: string) => {
    this.setState(setSafe(this.state, ['paths', key], value));
  }

  private browsePath = (key: string) => {
    this.context.api.selectDir({})
    .then((selectedPath: string) => {
      if (selectedPath) {
        this.changePath(key, selectedPath);
      }
    });
  }

  private renderActivators(activators: IModActivator[], currentActivator: string): JSX.Element {
    const { t } = this.props;

    if ((activators !== undefined) && (activators.length > 0)) {
      let activatorIdx: number = 0;
      if (currentActivator !== undefined) {
        activatorIdx = activators.findIndex((activator) => activator.id === currentActivator);
      }

      return (
        <div>
          <FormControl
            componentClass='select'
            value={currentActivator}
            onChange={this.selectActivator}
          >
            {activators.map(this.renderActivatorOption)}
          </FormControl>
          <HelpBlock>
            {activatorIdx !== -1 ? activators[activatorIdx].description : null}
          </HelpBlock>
        </div>
        );
    }
    return <ControlLabel>{ t('No mod activators installed') }</ControlLabel>;
  }

  private renderActivatorOption(activator: IModActivator): JSX.Element {
    return (
      <option key={activator.id} value={activator.id}>{activator.name}</option>
    );
  }

  private selectActivator = (evt) => {
    let target: HTMLSelectElement = evt.target as HTMLSelectElement;
    log('info', 'select activator', { id: target.value });
    this.props.onSetActivator(target.value);
  }
}

function mapStateToProps(state: any): IConnectedProps {
  return {
    paths: state.gameSettings.mods.paths,
    gameMode: state.settings.gameMode.current,
    currentActivator: state.gameSettings.mods.activator,
    state: state,
  };
}

function mapDispatchToProps(dispatch: Redux.Dispatch<any>): IActionProps {
  return {
    onSetPath: (key: string, newPath: string): void => {
      dispatch(setPath(key, newPath));
    },
    onSetActivator: (id: string): void => {
      dispatch(setActivator(id));
    },
    onShowDialog: (type, title, content, actions): void => {
      dispatch(showDialog(type, title, content, actions));
    },
    onShowError: (message: string, details: string | Error): void => {
      showError(dispatch, message, details);
    },
  };
}

export default
  translate(['common'], { wait: false })(
    connect(mapStateToProps, mapDispatchToProps)(Settings)
  ) as React.ComponentClass<{}>;
