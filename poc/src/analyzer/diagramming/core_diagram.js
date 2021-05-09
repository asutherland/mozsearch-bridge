const INDENT = '  ';

/**
 * Helper to cluster dot snippets inside subgraphs.
 */
export class HierNode {
  constructor(parent, hierarchyName, displayName, depth) {
    this.hierarchyName = hierarchyName;
    this.displayName = displayName;
    this.depth = depth;
    this.parent = parent;

    // XXX experimental styling.
    this.styling = null;

    // One of group/node for now
    this.nodeKind = null;
    // One of process/thread/class/method/etc.
    this.semanticKind = null;

    this.instanceGroup = null;

    // For nodes associated with symbols...
    /// The canonical symbol we're associating with this node.
    this.sym = null;
    /// Other symbols that we've also mapped to this node, likely due to
    /// method overloading which means we have a single pretty identifier for
    /// multiple symbols.
    this.altSyms = null;

    /**
     * One of:
     * - collapse: Collapse this node into its child.
     * - cluster: be a graphviz cluster
     * - table: be a table and therefore all children are records
     * - record: are a record because the parent is a table.
     * - node: Just be a node.
     */
    this.action = null;
    /**
     * Whenever a node collapses itself into its child, it accumulates itself
     * and its own value of this into its child.
     */
    this.collapsedAncestors = [];

    this.kids = new Map();

    // The graphviz id for this hierarchy node.
    this.id = '';
    // The id to use for this node for rank purposes.  For records, this is the
    // parent table.
    this.rankId = '';
    // The graphviz id to use for incoming edges.  This matters for ports.
    this.edgeInId = '';
    // The graphviz id to use for outgoing edges.  This matters for ports.
    this.edgeOutId = '';

    /**
     * List of { from, to } objects where from and to are both HierNodes.
     */
    this.edges = [];
    this.descendantEdgeCount = 0;
  }

  getOrCreateKid(hierarchyName, displayName) {
    let kid = this.kids.get(hierarchyName);
    if (kid) {
      return kid;
    }
    kid = new HierNode(this, hierarchyName, displayName, this.depth + 1);
    this.kids.set(hierarchyName, kid);
    return kid;
  }

  updateSym(sym) {
    if (!sym) {
      return;
    }
    // It can easily happen that multiple underlying symbols maps to the same
    // pretty/de-mangled name.  Just stash the alternate syms for now.
    if (this.sym) {
      if (!this.altSyms) {
        this.altSyms = [sym];
      } else {
        this.altSyms.push(sym);
      }
      console.warn('trying to clobber existing', this.sym, 'with', sym);
      return;
    }
    this.sym = sym;
  }

  /**
   * Logic around collapsedAncestors, re-joining with delimiters.  Ideally this
   * would be much smarter with us having better symbolic information at each
   * level of hierarchy.
   */
  computeLabel() {
    if (this.collapsedAncestors && this.collapsedAncestors.length) {
      return this.collapsedAncestors.join('::') + '::' + this.displayName;
    }
    return this.displayName;
  }

  computeClusterStyling() {
    if (this.instanceGroup) {
      return this.instanceGroup.computeClusterStyling(this);
    }
    return '';
  }

  /**
   * Any additional style info to emit.  Leading whitespace needs to be emitted.
   */
  computeNodeStyling() {
    if (this.instanceGroup) {
      return this.instanceGroup.computeNodeStyling(this);
    }
    // XXX handle instance also being applied...
    if (this.styling) {
      return this.styling;
    }
    return '';
  }

  computeTableStyling() {
    if (this.instanceGroup) {
      return this.instanceGroup.computeTableStyling(this);
    }
    return '';
  }

  static findCommonAncestor(fromNode, toNode) {
    if (!fromNode || !toNode) {
      return null;
    }
    // special-case self-edges to go in their parent.
    if (fromNode === toNode) {
      // only walk up if we're not somehow at the root.
      if (fromNode.parent) {
        return fromNode.parent;
      }
      return fromNode;
    }

    // Walk both nodes up to be at the same depth.
    const sameDepth = Math.min(fromNode.depth, toNode.depth);
    let curFromNode = fromNode;
    let curToNode = toNode;

    while (curFromNode.depth > sameDepth) {
      curFromNode = curFromNode.parent;
    }
    while (curToNode.depth > sameDepth) {
      curToNode = curToNode.parent;
    }

    // Now that both nodes are at the same level of depth, we're already in the
    // same ancestor, or we keep walking up in lock-step until we find an
    // ancestor or we encounter the root node.
    while (curFromNode !== curToNode && curFromNode.parent) {
      curFromNode = curFromNode.parent;
      curToNode = curToNode.parent;
    }

    return curFromNode;
  }
}

// TODO: Extract out the class-diagram specific logic so the blockly
// HierNodeGenerator (which subclasses this now), can use the node action logic
// without running into the logic that assumes everything is a symbol.
export class HierBuilder {
  constructor(settingOverrides) {
    this.root = new HierNode(null, '', '', 0);

    // default algorithmic settings that will get mutated by any 'setting_algo'
    // block we see.  (And there could be multiple contradictory ones right
    // now.)
    this.settings = Object.assign(
      {
        layoutDir: 'TB',
        engine: 'dot',
      }, settingOverrides);

    this.idCounter = 0;
    this.nodeIdToNode = new Map();

    // InstanceGroupInstances get crammed in here so they can contribute to
    // the final rendered dot.
    this.topLevelExtra = [];
  }

  _determineNodeAction(node, classAncestor, inTable) {
    const isRoot = node.parent === null;

    // If the node has only one child and no edges, we can collapse it UNLESS
    // the child is a class, in which case we really don't want to.
    if (!isRoot && !inTable &&
        node.kids.size === 1 && node.edges.length === 0) {
      const soleKid = Array.from(node.kids.values())[0];

      // The child's needs impact our ability to collapse:
      // - If the kid is a class, don't collapse into it.  (Classes can still
      //   be clusters, but the idea is they should/need to be distinguished
      //   from classes.)
      if (soleKid.nodeKind !== 'group' &&
          (!soleKid.sym || !soleKid.sym.isClass)) {
        node.id = node.rankId = node.edgeInId = node.edgeOutId = '';
        node.action = 'collapse';
        soleKid.collapsedAncestors = node.collapsedAncestors.concat(node);
        this._determineNodeAction(soleKid, false);
        return;
      }
    }

    const isClass = node.sym && node.sym.isClass;
    let beClass = classAncestor || isClass;
    let beInTable = inTable;

    if (isRoot) {
      node.action = 'flatten';
      node.id = node.rankId = node.edgeInId = node.edgeOutId = '';
    }
    else if (inTable) {
      // there are no more decisions to make if we're in a table; we're a record
      node.action = 'record';
      // and we must shunt our edges to our table's parent.
      inTable.parent.edges.push(...node.edges);
      node.edges = null;

      node.id = 'p' + (this.idCounter++);
      node.rankId = node.parent.id;
      // our ports don't exist in isolation, we also need to include our
      // table parent's id.
      node.edgeInId = node.parent.id + ':' + node.id + ':w';
      node.edgeOutId = node.parent.id + ':' + node.id + ':e';
    }
    // If things have collapsed into us or there are edges at our level, we
    // need to be a cluster.
    else if (node.nodeKind === 'group' ||
             node.collapsedAncestors.length || node.edges.length > 0) {
      node.action = 'cluster';
      node.id = node.rankId = 'cluster_c' + (this.idCounter++);
      node.edgeInId = node.edgeOutId = 'placeholder_' + node.id;
    }
    // If the number of internal edges are low and we've reached a class AND
    // there are children, then we can switch to being a table.
    else if (beClass && (node.descendantEdgeCount < 5) && node.kids.size) {
      node.action = 'table';
      beInTable = node;
      node.id = node.rankId = 't' + (this.idCounter++);
      const slotId = node.id + 's0';
      node.edgeInId = slotId + ':w';
      node.edgeOutId = slotId + ':e';
    }
    // If there are kids, we want to be a cluster after all.
    else if (node.kids.size > 0) {
      node.action = 'cluster';
      node.id = node.rankId = 'cluster_c' + (this.idCounter++);
      node.edgeInId = node.edgeOutId = node.id;
    }
    // And if there were no kids, we should just be a standard node.
    else {
      node.action = 'node';
      node.id = node.rankId = 'n' + (this.idCounter++);
      node.edgeInId = node.edgeOutId = node.id;
    }

    this.nodeIdToNode.set(node.id, node);

    for (const kid of node.kids.values()) {
      this._determineNodeAction(kid, beClass, beInTable);
    }
  }

  determineNodeActions() {
    this.idCounter = 1;
    this._determineNodeAction(this.root, false, null);
    if (window.DEBUG_DIAGRAM) {
      console.log('root node of graph post-determine:', this.root);
    }
  }

  /**
   * Notable things:
   * - The normal nodes produce <title>nodeid</title> elements that we rewrite
   *   in `renderToSVG` to instead be data-symbols on their parent element.
   * - The use of "href" on the label <TD> nodes results in a "g" wrapping an
   *   "<a xlink:href xlink:title>".  We currently transform the "a" into a g,
   *   but could instead manipulate the outer id which ends up with an `id`.
   *   However, our fix-up pass in renderToSVG is doing things with regexps,
   *   not the DOM, so simpler may be better.
   */
  _renderNode(node, indentStr) {
    let s = '';

    let kidIndent = indentStr;
    let wrapEnd = '';
    if (node.action === 'collapse') {
      const soleKid = Array.from(node.kids.values())[0];
      return this._renderNode(soleKid, indentStr);
    } else if (node.action === 'cluster') {
      s += indentStr + `subgraph ${node.id} {\n${node.computeClusterStyling()}`;
      kidIndent += INDENT;
      s += kidIndent + `${node.edgeInId} [shape=point style=invis]\n`;
      s += kidIndent + `label = "${node.computeLabel()}";\n\n`;
      wrapEnd = indentStr + '}\n';
    } else if (node.action === 'table') {
      s += indentStr + `${node.id} [label=<<table border="0" cellborder="1" cellspacing="0" cellpadding="4">\n`;
      kidIndent += INDENT ;
      s += kidIndent + `<tr><td href="${node.id}" port="${node.id}s0" ${node.computeTableStyling()}><B>${node.computeLabel()}</B></td></tr>\n`;
      wrapEnd = indentStr + `</table>>];\n`;
    } else if (node.action === 'record') {
      // XXX tables can potentially have more than 1 level of depth; we need
      // to be doing some type of indentation or using multiple columns/etc.
      // XXX we want to do some additional label styling...
      s += indentStr + `<tr><td href="${node.id}" port="${node.id}"  ${node.computeTableStyling()}>${node.computeLabel()}</td></tr>\n`;
      // this is a stop-gap to visually show when we're screwing up in the output.
      kidIndent += INDENT;
    } else if (node.action === 'node') {
      s += indentStr + `${node.id} [label="${node.computeLabel()}"${node.computeNodeStyling()}];\n`;
    } // else 'flatten'

    for (const kid of node.kids.values()) {
      s += this._renderNode(kid, kidIndent) + '\n';
    }

    // node.edges may be null if shunted to the parent in the 'record' case.
    // Also skip if there are no edges to avoid filling the output up with
    // a million unused newlines.
    if (node.edges && node.edges.length) {
      s += '\n';
      for (const { from, to, style } of node.edges) {
        // HACK: Don't expose edges to the root node.
        // This is a scenario that happens when clicking on a class Type because
        // all of the members end up referring to the Type itself.
        if (!from.edgeOutId || !to.edgeInId) {
          continue;
        }
        s += kidIndent + from.edgeOutId + ' -> ' + to.edgeInId;
        const attrBits = [];
        if (from.action === 'cluster') {
          attrBits.push(`ltail=${from.id}`);
        }
        if (to.action === 'cluster') {
          attrBits.push(`lhead=${to.id}`);
        }
        if (style) {
          attrBits.push(`style="${style}"`);
        }
        if (attrBits.length) {
          s += `[${attrBits.join(', ')}]\n`;
        } else {
          s += '\n';
        }
      }
    }

    s += wrapEnd;

    return s;
  }

  renderToDot() {
    const dotBody = this._renderNode(this.root, INDENT);
    const topLevelLines = this.topLevelExtra.reduce((accum, renderer) => {
      return accum + renderer.renderTopLevelDot();
    }, '');
    const dot = `digraph "" {
  newrank = true;
  compound = true;
  rankdir = "${this.settings.layoutDir}";
  fontname = "Arial";
  splines = spline;

  node [shape=none, fontname="Arial", fontsize=10, colorscheme=pastel28];
  edge [arrowhead=open];

  ${dotBody}
  ${topLevelLines}
}`;

    return dot;
  }
}
