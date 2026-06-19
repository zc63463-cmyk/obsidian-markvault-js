/**
 * Layout Engine — 导图布局工厂
 *
 * 支持 8 种布局：
 *   - tree-right (默认): 右侧树形，根在左，子向右
 *   - tree-left:        左侧树形，根在右，子向左
 *   - org:              自上而下组织架构图，根在顶，子向下
 *   - logic-right:      逻辑图，同级节点紧凑无子树堆叠
 *   - fishbone:         鱼骨图，水平脊线 + 上下交替分支
 *   - timeline:         时间轴，水平主轴 + 上下交替事件
 *   - radial:           径向布局，根在中心，子节点环绕辐射
 *   - freeform:         自由布局，震散+碰撞避让，适合创意发散
 */

import type { MindNode, LayoutType } from '../types/mind-node';
import {
  layoutTree as treeRightLayout,
  layoutTreeLeft,
  layoutLogicRight,
  relayoutWithMeasured as treeRightRelayout,
  relayoutWithMeasuredLeft,
  relayoutLogicRight,
} from './tree-layout';
import { orgLayoutTree, orgRelayoutWithMeasured } from './tree-org-layout';
import { fishboneLayoutTree, fishboneRelayoutWithMeasured } from './fishbone-layout';
import { timelineLayoutTree, timelineRelayoutWithMeasured } from './timeline-layout';
import { radialLayoutTree, radialRelayoutWithMeasured } from './radial-layout';
import { freeformLayoutTree, freeformRelayoutWithMeasured } from './freeform-layout';

export function layoutTree(root: MindNode, layout: LayoutType = 'tree-right'): MindNode {
  switch (layout) {
    case 'tree-left': return layoutTreeLeft(root);
    case 'org': return orgLayoutTree(root);
    case 'logic-right': return layoutLogicRight(root);
    case 'fishbone': return fishboneLayoutTree(root);
    case 'timeline': return timelineLayoutTree(root);
    case 'radial': return radialLayoutTree(root);
    case 'freeform': return freeformLayoutTree(root);
    default: return treeRightLayout(root);
  }
}

export function relayoutWithMeasured(root: MindNode, layout: LayoutType = 'tree-right'): MindNode {
  switch (layout) {
    case 'tree-left': return relayoutWithMeasuredLeft(root);
    case 'org': return orgRelayoutWithMeasured(root);
    case 'logic-right': return relayoutLogicRight(root);
    case 'fishbone': return fishboneRelayoutWithMeasured(root);
    case 'timeline': return timelineRelayoutWithMeasured(root);
    case 'radial': return radialRelayoutWithMeasured(root);
    case 'freeform': return freeformRelayoutWithMeasured(root);
    default: return treeRightRelayout(root);
  }
}
