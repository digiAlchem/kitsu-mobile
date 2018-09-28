import React, { PureComponent } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  Platform,
  PushNotificationIOS,
} from 'react-native';
import FastImage from 'react-native-fast-image';
import { connect } from 'react-redux';
import Icon from 'react-native-vector-icons/FontAwesome';
import PropTypes from 'prop-types';
import OneSignal from 'react-native-onesignal';
import moment from 'moment';
import { Kitsu } from 'kitsu/config/api';
import {
  fetchNotifications,
  markNotifications,
  markAllNotificationsAsRead,
} from 'kitsu/store/feed/actions';
import { Navigation } from 'react-native-navigation';
import { Screens } from 'kitsu/navigation';
import store from 'kitsu/store/config';
import * as types from 'kitsu/store/types';
import { isEqual } from 'lodash';
import { parseNotificationData } from 'kitsu/utils/notifications';
import { styles } from './styles';
import { NotificationHeader } from './NotificationHeader';

// TODO: Add fetching notifications every X minutes

class NotificationsScreen extends PureComponent {
  state = {
    unreadCount: 0,
  };

  componentWillMount() {
    // Register all global app events here
    OneSignal.inFocusDisplaying(2);
    OneSignal.addEventListener('ids', this.onIds);
    OneSignal.addEventListener('registered', this.onPNRegistered);
    OneSignal.addEventListener('received', this.onReceived);
    OneSignal.addEventListener('opened', this.onOpened);
  }

  componentDidMount = () => {
    // for once, and listener will invoke afterwards.
    OneSignal.requestPermissions({ alert: true, sound: true, badge: true });
    this.fetchNotifications();
  };

  componentWillReceiveProps(nextProps) {
    if (!isEqual(this.props.notifications, nextProps.notifications)) {
      this.updateNotificationCount(nextProps);
    }
  }

  componentWillUnmount() {
    OneSignal.removeEventListener('ids', this.onIds);
    OneSignal.removeEventListener('registered', this.onPNRegistered);
    OneSignal.removeEventListener('received', this.onReceived);
    OneSignal.removeEventListener('opened', this.onOpened);
  }

  onIds = (device) => {
    console.log(device.userId);
    store.dispatch({ type: types.ONESIGNAL_ID_RECEIVED, payload: device.userId });
  }

  onPNRegistered = (notificationData) => {
    console.log('device registered', notificationData);
  };

  onReceived = (notification) => {
    console.log('Notification received: ', notification);
    this.updateNotificationCount();
  }

  onOpened = (openResult) => {
    console.group('Opened Notification');
    console.log('Notification', openResult.notification);
    console.log('Message: ', openResult.notification.payload.body);
    console.log('Data: ', openResult.notification.payload.additionalData);
    console.log('isActive: ', openResult.notification.isAppInFocus);
    console.log('openResult: ', openResult);
    console.groupEnd();

    // Show notification tab
    // TODO: Need a way to make sure that users who are not logged in don't get notifications
    Navigation.mergeOptions(Screens.BOTTOM_TABS, {
      bottomTabs: {
        currentTabId: Screens.NOTIFICATION,
      },
    });
  }

  /**
   * Marks all notifications as read, currently triggered from NotificationHeader.
   */
  onMarkAll = async () => {
    await this.props.markAllNotificationsAsRead();
    this.updateNotificationCount();
  };

  /**
   * Navigates to related screen on user row item press
   *
   * @param {Object} activity Activity of notification row data
   * @memberof NotificationsScreen
   */
  onNotificationPressed = async ({ activity, notification }) => {
    const { target, verb, actor } = activity;
    const { currentUser, componentId } = this.props;
    this.markNotifications([notification], 'read');
    switch (verb) {
      case 'follow':
        Navigation.push(componentId, {
          component: {
            name: Screens.PROFILE_PAGE,
            passProps: { userId: actor.id || currentUser.id },
          },
        });
        break;
      case 'invited':
        break;
      case 'vote':
        try {
          const response = await this.fetchMediaReactions(target[0].id);
          Navigation.push(componentId, {
            component: {
              name: Screens.MEDIA_PAGE,
              passProps: {
                mediaId: (response.anime && response.anime.id) || (response.manga && response.manga.id),
                mediaType: response.anime ? 'anime' : 'manga',
              },
            },
          });
        } catch (e) {
          console.log(e);
        }
        break;
      case 'post':
        if (target.length !== 0) {
          Navigation.push(componentId, {
            component: {
              name: Screens.FEED_POST_DETAILS,
              passProps: {
                post: target[0],
                comments: [],
                like: null,
                currentUser,
              },
            },
          });
        } else { // should be a "mention"
          const post = await this.fetchPost(activity);
          if (post) {
            Navigation.push(componentId, {
              component: {
                name: Screens.FEED_POST_DETAILS,
                passProps: {
                  post,
                  comments: [],
                  like: null,
                  currentUser,
                },
              },
            });
          }
        }
        break;
      case 'post_like':
      case 'comment_like':
      case 'comment':
        if (target.length !== 0) {
          Navigation.push(componentId, {
            component: {
              name: Screens.FEED_POST_DETAILS,
              passProps: {
                post: target[0],
                comments: [],
                like: null,
                currentUser,
              },
            },
          });
        }
        break;
      default:
        break;
    }
  };

  /**
   * Fetches media reaction.
   * @param {number} mediaId Media ID of notification target ID.
   * @memberof NotificationsScreen
   */
  // TODO: temporary request to fetch mediareactions & to navigate corresponding
  // media screen. (since we don't have mediareactions screen right now)
  fetchMediaReactions = async mediaId =>
    Kitsu.find('mediaReactions', mediaId, {
      include: 'user,anime,manga',
    });

  /**
   * Fetches post by extracting postId from activity foreignId.
   * Created for fetching mentions in a hacky way.
   * @param {object} activity Activity object from notifications
   * @returns {object} post
   * @memberof NotificationsScreen
   */
  fetchPost = async (activity) => {
    if (!activity.foreignId) return null;
    const postId = activity.foreignId.split(':')[1];
    let post;
    try {
      post = await Kitsu.find('posts', postId, {
        include: 'user,targetUser,targetGroup,media,uploads',
      });
    } catch (e) {
      console.log(e);
    }
    return post;
  };

  /**
   * Fetches notifications and immediately marks them as read.
   * @memberof NotificationsScreen
   */
  fetchNotifications = async () => {
    const { loadingNotifications } = this.props;

    if (!loadingNotifications) {
      await this.props.fetchNotifications();
      await this.markNotifications(this.props.notifications, 'seen');
      PushNotificationIOS.setApplicationIconBadgeNumber(0);
      
    }
  };

  /**
   * Fetches more notifications and appends them to current state.
   * loadingMoreNotifications flag is for throtling scroll event.
   * @memberof NotificationsScreen
   */
  fetchMoreNotifications = async () => {
    const { loadingMoreNotifications, notifications } = this.props;
    if (!loadingMoreNotifications) {
      await this.props.fetchNotifications(notifications.slice(-1)[0].id);
      this.markNotifications(this.props.notifications, 'seen');
    }
  };

  markNotifications = async (notifications, type) => {
    await this.props.markNotifications(notificatios, type);
    this.updateNotificationCount();
  }

  updateNotificationCount = (props = this.props) => {
    const { notifications } = props;
    const unreadCount = notifications.reduce((count, notification) => count + ((notification && notification.isRead) ? 0 : 1), 0);
    const badge = unreadCount > 0 ? `${unreadCount}` : '';

    // Set the state and the badges
    this.setState({ unreadCount });
    Navigation.mergeOptions(Screens.NOTIFICATION, {
      bottomTab: {
        badge,
      },
    });
  }

  resetScrollPosition = () => {
    this.list.scrollToOffset({ x: 0, y: 0, animated: true });
  }

  handleActionBtnPress = () => {
    if (Platform.OS === 'ios') {
      OneSignal.requestPermissions({ alert: true, sound: true, badge: true });
    }
  };

  renderText = (activities) => {
    const { currentUser: { id } } = this.props;
    return <Text>{parseNotificationData(activities, id).text}</Text>;
  };

  renderItem = ({ item }) => {
    const activity = item.activities[0];
    let others = null;
    if (item.activities.length > 1) {
      others =
        item.activities.length === 2 ? (
          <Text style={{ color: '#333', fontWeight: '500' }}>
            {item.activities[1].actor ? item.activities[1].actor.name : 'Unknown'}{' '}
          </Text>
        ) : (
          <Text>{item.activities.length - 1} others </Text>
        );
    }
    const ava =
      activity.actor && activity.actor.avatar
        ? activity.actor.avatar.tiny
        : 'https://staging.kitsu.io/images/default_avatar-ff0fd0e960e61855f9fc4a2c5d994379.png';

    return (
      <TouchableOpacity
        onPress={() => this.onNotificationPressed({ notification: item, activity })}
      >
        <View style={[styles.parentItem, { opacity: item.isRead ? 0.7 : 1 }]}>
          <View style={styles.iconContainer}>
            <Icon name="circle" style={[styles.icon, !item.isRead && styles.iconUnread]} />
          </View>
          <View style={styles.detailsContainer}>
            <View style={{ paddingRight: 10 }}>
              <FastImage style={styles.userAvatar} source={{ uri: ava }} cache="web" />
            </View>
            <View style={styles.activityContainer}>
              <View style={styles.activityTextContainer}>
                <Text style={[styles.activityText, styles.activityTextHighlight]}>
                  {activity.actor && activity.actor.name}{' '}
                </Text>
                <Text style={styles.activityText}>
                  {others && <Text>and {others}</Text>}
                  {this.renderText(item.activities)}
                </Text>
              </View>
              <View style={styles.activityMetaContainer}>
                <Text style={styles.activityMetaText}>{moment(activity.time).fromNow()}</Text>
              </View>
            </View>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  renderItemSeperator = () => <View style={styles.itemSeperator} />;

  renderHeader = () => {
    if (!this.props.pushNotificationEnabled) {
      return (
        <View style={styles.noticeContainer}>
          <Text style={styles.noticeText}>Kitsu is better with notifications!</Text>
          <TouchableOpacity style={styles.actionButton} onPress={this.handleActionBtnPress}>
            <Text style={styles.actionButtonText}>Turn on notifications</Text>
          </TouchableOpacity>
          <Icon name="close" style={styles.closeIcon} />
        </View>
      );
    }
    return <View />;
  };

  render() {
    const { notifications, loadingNotifications, markingRead } = this.props;
    const { unreadCount } = this.state;
    return (
      <View style={styles.container}>
        <NotificationHeader
          markingRead={markingRead}
          unreadCount={unreadCount}
          onMarkAll={this.onMarkAll}
        />
        <FlatList
          ref={(r) => { this.list = r; }}
          ListHeaderComponent={this.renderHeader}
          data={notifications}
          renderItem={this.renderItem}
          keyExtractor={item => `${item.id}`}
          ItemSeparatorComponent={this.renderItemSeperator}
          initialNumToRender={10}
          refreshing={loadingNotifications}
          onRefresh={this.fetchNotifications}
          onMomentumScrollBegin={() => {
            // Prevent iOS calling onendreached when list is loaded.
            this.onEndReachedCalledDuringMomentum = false;
          }}
          onEndReached={() => {
            if (!this.onEndReachedCalledDuringMomentum) {
              this.fetchMoreNotifications();
              this.onEndReachedCalledDuringMomentum = true;
            }
          }}
          onEndReachedThreshold={0.5}
          style={styles.container}
        />
      </View>
    );
  }
}

NotificationsScreen.propTypes = {
  fetchNotifications: PropTypes.func.isRequired,
  currentUser: PropTypes.object.isRequired,
  notifications: PropTypes.array.isRequired,
  loadingNotifications: PropTypes.bool.isRequired,
  markNotifications: PropTypes.func.isRequired,
  markAllNotificationsAsRead: PropTypes.func.isRequired,
  markingRead: PropTypes.bool.isRequired,
  pushNotificationEnabled: PropTypes.bool.isRequired,
};

const mapStateToProps = ({ feed, user, app }) => {
  const { notifications, loadingNotifications, markingRead } = feed;
  const { currentUser } = user;
  const { pushNotificationEnabled } = app;
  return {
    notifications,
    loadingNotifications,
    currentUser,
    pushNotificationEnabled,
    markingRead,
  };
};
export default connect(mapStateToProps, {
  fetchNotifications,
  markAllNotificationsAsRead,
  markNotifications,
})(NotificationsScreen);
