var util = require("util");
var events = require("events");
var ncurses = require("ncurses");
var mysql = require("mysql");
var tty = require("tty");
var child_process = require("child_process");

process.stdin.resume();
process.stdin.setEncoding('utf8');
tty.setRawMode(true);

var Modes = {
  COMMITCHANGE: 0
}

function ApplicationImpl() {
  this._ncWindow = null;
  this.mode = null;
  this.bugWindow = null;
  this.logMessageWindow = null;
}

ApplicationImpl.prototype.start = function (mode) {
  var context = this;
  this.mode = mode || Modes.COMMITCHANGE;
  this.createDefaultWindow();
  switch (this.mode) {
    case Modes.COMMITCHANGE:
      context.bugWindow = new BugWindow(ncurses.lines, ncurses.cols);
      this.bugWindow.setTitle("Select Bugs Fixed in This Change (Filter: All Open Bugs)");
      this.bugWindow.setStatusLine("Ctrl+Q: Quit   ESC: Back   F12: Submit");
      this.bugWindow.on('hide', function () {
        var __updateLogMessageWindowTitle = function () {
          var nbugs = context.bugWindow.bugsSelected.length;
          var bugtext = "(" + (nbugs == 0 ? "no bugs" : nbugs + (nbugs == 1 ? " bug" : " bugs")) + " selected)";
          context.logMessageWindow.setTitle("Change Summary " + bugtext);
          context.logMessageWindow.setStatusLine("Ctrl+Q: Quit   ESC: Back   F12: Submit");
          context._ncWindow.refresh();
        };
        if (!context.logMessageWindow) {
          context.logMessageWindow = new LogMessageWindow(ncurses.lines, ncurses.cols);
          __updateLogMessageWindowTitle();
          context.logMessageWindow.on('back', function () {
            context.logMessageWindow.hide();
            if (context.bugWindow) {
              context.bugWindow.show();
            }
          });
        } else {
          context.logMessageWindow.show(__updateLogMessageWindowTitle);
        }
      });
      break;
    default:
      this.close("fatal error: trying to enter invalid mode");
      break;
  }
  this.paint();
}

ApplicationImpl.prototype.createDefaultWindow = function () {
  if (!this._ncWindow) {
    this._ncWindow = new ncurses.Window();
    this.clearPaintSpace();
  } else {
    this.close("why are you trying to create multiple default windows?");
  }
}

ApplicationImpl.prototype.paint = function () {
  if (this.bugWindow && !this.bugWindow.isHidden) {
    this.bugWindow.paint();
  }
  if (this.logMessageWindow && !this.logMessageWindow.isHidden) {
    this.logMessageWindow.paint();
  }
  ncurses.redraw();
}

ApplicationImpl.prototype.respondToKeyPress = function (chunk, key) {
  if (key && key.name == "q" && key.ctrl) {
    this.close();
  } else {
    if (this.bugWindow && !this.bugWindow.isHidden) {
      this.bugWindow.respondToKeyPress(chunk, key);
    }
    if (this.logMessageWindow && !this.logMessageWindow.isHidden) {
      this.logMessageWindow.respondToKeyPress(chunk, key);
    }
  }
}

ApplicationImpl.prototype.clearPaintSpace = function () {
  if (!this._ncWindow) {
    this.close("clearPaintSpace called while _ncWindow was null");
  } else {
    this._ncWindow.erase();
    this._ncWindow.cursor(0,0);
    this._ncWindow.refresh();
  }
}

ApplicationImpl.prototype.close = function (exitmsg) {
  var context = this;
  var expectedWindowsClosing = 0, windowsClosed = 0;
  var __finishApplicationShutdown = function () {
    context.clearPaintSpace();
    context._ncWindow.close();
    ncurses.redraw();
    ncurses.cleanup();
    if (exitmsg) {
      console.log(exitmsg);
    }
    process.exit(1);
  };
  var __notifyWindowClosed = function () {
    if (++windowsClosed == expectedWindowsClosing) {
      __finishApplicationShutdown();
    }
  };
  var __ensureWindowCloses = function (win) {
    if (win) {
      expectedWindowsClosing++;
      win.close(__notifyWindowClosed);
    }
  };
  __ensureWindowCloses(this.bugWindow);
  __ensureWindowCloses(this.logMessageWindow);
}

var Application = new ApplicationImpl();

Application.createDefaultWindow();

var Colors = {
  NORMAL: 0,
  SELECTED: 1,
  TEXTENTRY: 2
}

ncurses.colorPair(Colors.SELECTED, ncurses.colors.WHITE, ncurses.colors.GREEN);
ncurses.colorPair(Colors.TEXTENTRY, ncurses.colors.WHITE, ncurses.colors.BLUE);

function ControlWindow(lines, cols, begy, begx) {
  this._ncWindow = null;
  this.isClosed = false;
  this.isHidden = false;
  if (lines || cols || begy || begx) {
    this.createNCWindow(false, lines, cols, begy, begx);
  }
  events.EventEmitter.call(this);
}
util.inherits(ControlWindow, events.EventEmitter);

ControlWindow.prototype.createNCWindow = function (createDefaultWindow, lines, cols, begy, begx) {
  if (lines && cols) {
    if (begy) {
      if (begx) {
        this._ncWindow = new ncurses.Window(lines, cols, begy, begx);
      } else {
        this._ncWindow = new ncurses.Window(lines, cols, begy);
      }
    } else {
      this._ncWindow = new ncurses.Window(lines, cols);
    }
  } else if (createDefaultWindow) {
    this._ncWindow = new ncurses.Window();
  }
}

ControlWindow.prototype.paint = function () {
  if (this.isClosed) {
    Application.close("fatal error: trying to paint closed window");
  }
}

ControlWindow.prototype.respondToKeyPress = function (chunk, key) {
}

ControlWindow.prototype.hide = function () {
  if (this.isClosed) {
    Application.close("fatal error: trying to call hide on closed window");
  }
  this._ncWindow.hide();
  this.isHidden = true;
  this.emit('hide');
}

ControlWindow.prototype.show = function (callback) {
  if (this.isClosed) {
    Application.close("fatal error: trying to call show on closed window");
  }
  this._ncWindow.show();
  this.isHidden = false;
  if (callback) {
    callback();
  }
  this._ncWindow.refresh();
  this.emit('show');
}

ControlWindow.prototype.close = function (callback) {
  var context = this;
  setTimeout(function () {
    if (!context.isClosed) {
      context.isClosed = true;
      context._ncWindow.erase();
      context._ncWindow.refresh();
      context._ncWindow.close();
      ncurses.redraw();
      context.emit('close');
    }
    if (callback) {
      callback();
    }
  }, 25);
}

function AppWindow(lines, cols, begy, begx) {
  ControlWindow.prototype.constructor.call(this, lines, cols, begy, begx);
  this._ncWindow.setscrreg(1, lines - 1);
  this.title = null;
  this.statusLine = null;
  events.EventEmitter.call(this);
}
util.inherits(AppWindow, ControlWindow);

AppWindow.prototype.paintFrame = function () {
  if (this.isClosed) {
    Application.close("fatal error: trying to paint frame of closed window");
  }
  var save_cury = this._ncWindow.cury;
  var save_curx = this._ncWindow.curx;
  this._ncWindow.frame(this.title);
  this._ncWindow.cursor(save_cury, save_curx);
}

AppWindow.prototype.paintStatusLine = function () {
  if (this.isClosed) {
    Application.close("fatal error: trying to paint status line of closed window");
  }
  if (this.statusLine) {
    var save_cury = this._ncWindow.cury;
    var save_curx = this._ncWindow.curx;
    this._ncWindow.centertext(this._ncWindow.maxy, this.statusLine);
    this._ncWindow.cursor(save_cury, save_curx);
  }
}

AppWindow.prototype.paint = function () {
  var save_cury = this._ncWindow.cury;
  var save_curx = this._ncWindow.curx;
  ControlWindow.prototype.paint.call(this);
  this.paintFrame();
  this.paintStatusLine();
  this._ncWindow.cursor(save_cury, save_curx);
}

AppWindow.prototype.setTitle = function (title) {
  if (this.isClosed) {
    Application.close("fatal error: trying to set title of closed window");
  }
  this.title = title;
  this.paint();
}

AppWindow.prototype.setStatusLine = function (stl) {
  if (this.isClosed) {
    Application.close("fatal error: trying to set statusline of closed window");
  }
  if (this.statusLine && stl.length < this.statusLine.length) {
    this.paintFrame();
  }
  this.statusLine = stl;
  this.paintStatusLine();
}

AppWindow.prototype.respondToKeyPress = function (chunk, key) {
  ControlWindow.prototype.respondToKeyPress.call(this, chunk, key);
  if (key && key.name == "escape") {
    this.emit('back');
  }
}

function BugWindow(lines, cols, begy, begx, bugdb) {
  lines = lines || 35;
  cols = cols || 75;
  AppWindow.prototype.constructor.call(this, lines, cols, begy, begx);
  this._ncWindow.idlok(true);
  this._ncWindow.cursor(1, 1);
  this.bugcache = null;
  this.bugsSelected = [];
  this.client = mysql.createClient({
    user: "example_username",
    password: "example_password", // TODO: Don't store passwords in plaintext! :O
    database: bugdb || "example_database"
  });
  this.scrollOffset = 0;
}
util.inherits(BugWindow, AppWindow);

BugWindow.prototype.fetchBugs = function (callback) {
  var context = this;
  this.bugcache = [];
  this.client.query("SELECT id, title FROM bugs ORDER BY id", function (err, results, fields) {
    if (err) {
      throw err;
    }
    var i = 0;
    for (var each in results) {
      var bugid = results[each]["id"];
      var bugtitle = results[each]["title"];
      (function () { this.bugcache[i++] = {id: bugid, title: bugtitle}; }).call(context);
    }
    if (callback) {
      callback.call(context);
    }
  });
}

BugWindow.prototype.paintSingleBugAtCursor = function (bug) {
  var save_cury = this._ncWindow.cury;
  var save_curx = this._ncWindow.curx;
  var bugSelected = this.isBugSelected(bug);
  var bugString = bug.id + ": " + bug.title;
  if (bugSelected) {
    this._ncWindow.attron(ncurses.colorPair(Colors.SELECTED));
    this._ncWindow.attron(ncurses.attrs.BOLD);
  } else {
    this._ncWindow.attron(ncurses.colorPair(Colors.NORMAL));
  }
  if (bugString.length <= this._ncWindow.maxx - 2) {
    this._ncWindow.print(bugString);
  } else {
    this._ncWindow.addstr(bugString, this._ncWindow.maxx - 5);
    this._ncWindow.addstr("...");
  }
  if (bugSelected) {
    this._ncWindow.attroff(ncurses.attrs.BOLD);
    this._ncWindow.attroff(ncurses.colorPair(Colors.SELECTED));
  } else {
    this._ncWindow.attroff(ncurses.colorPair(Colors.NORMAL));
  }
  this._ncWindow.cursor(save_cury, save_curx);
  this._ncWindow.refresh();
}

BugWindow.prototype.paintBugViewport = function () {
  var save_cury = this._ncWindow.cury;
  var save_curx = this._ncWindow.curx;
  var i = 0;
  if (!this.bugcache) {
    this.fetchBugs(this.paintBugViewport);
  } else {
    for (var each in this.bugcache) {
      if (i >= this.scrollOffset) {
        if (i >= this._ncWindow.maxy - 1 + this.scrollOffset) {
          break;
        }
        this._ncWindow.cursor(parseInt(each) + 1 - this.scrollOffset, 1);
        this.paintSingleBugAtCursor(this.bugcache[each]);
        this._ncWindow.cursor(this._ncWindow.cury, 1);
        this._ncWindow.refresh();
      }
      i++;
    }
  }
  this._ncWindow.cursor(save_cury, save_curx);
  this._ncWindow.refresh();
}

BugWindow.prototype.paint = function () {
  var save_cury = this._ncWindow.cury;
  var save_curx = this._ncWindow.curx;
  this._ncWindow.erase();
  AppWindow.prototype.paint.call(this);
  this.paintBugViewport();
  this._ncWindow.cursor(save_cury, save_curx);
  this._ncWindow.refresh();
}

BugWindow.prototype.isBugSelected = function(bug) {
  for (var each in this.bugsSelected) {
    if (bug.id == this.bugsSelected[each].id) {
      return each; // super useful!
    }
  }
  return false;
}

BugWindow.prototype.handleSelection = function(bugloc) {
  bugloc = parseInt(bugloc);
  var bug = this.bugcache[bugloc];
  var isCanceledSelection = false;
  this._ncWindow.cursor(bugloc + 1 - this.scrollOffset, 1);
  selectedIndex = this.isBugSelected(bug);
  if (selectedIndex) {
    this.bugsSelected.splice(selectedIndex, 1);
  } else {
    this.bugsSelected.push(bug);
  }
  this.paintSingleBugAtCursor(bug);
}

BugWindow.prototype.handleMoveUp = function () {
  if (this._ncWindow.cury > 1) {
    this._ncWindow.cursor(this._ncWindow.cury - 1, this._ncWindow.curx);
  } else if (this.scrollOffset > 0) {
    this._ncWindow.cursor(1, this._ncWindow.curx);
    this.scrollOffset--;
    this.paint();
  }
}

BugWindow.prototype.handleMoveDown = function () {
  if (this._ncWindow.cury < this.bugcache.length && this._ncWindow.cury < this._ncWindow.maxy - 1) {
    this._ncWindow.cursor(this._ncWindow.cury + 1, this._ncWindow.curx);
  } else if (this._ncWindow.cury + this.scrollOffset < this.bugcache.length) {
    this.scrollOffset++;
    this.paint();
  }
}

BugWindow.prototype.respondToKeyPress = function(chunk, key) {
  AppWindow.prototype.respondToKeyPress.call(this, chunk, key);
  if (chunk == 'k' || (key && key.name == "up")) {
    this.handleMoveUp();
  } else if (chunk == 'j' || (key && key.name == "down")) {
    this.handleMoveDown();
  } else if (key && key.name == "enter") {
    this.handleSelection(this._ncWindow.cury - 1 + this.scrollOffset);
  } else if (key && key.name == "f12") {
    this.hide();
  }
  this._ncWindow.refresh();
}

function TextBoxControl(lines, cols, begy, begx) {
  ControlWindow.prototype.constructor.call(this, lines, cols, begy, begx);
  this.isFocused = null;
  this.cursorOffset = 0;
  this.textBuffer = "";
  this.allowResize = false;
  this.maxLinesAllowed = -1; // unlimited by default
  this.focus();
}
util.inherits(TextBoxControl, ControlWindow);

TextBoxControl.prototype.paintTextBuffer = function () {
  this._ncWindow.erase();
  this._ncWindow.cursor(0, 0);
  this._ncWindow.print(this.textBuffer);
  this._ncWindow.refresh();
}

TextBoxControl.prototype.paint = function () {
  ControlWindow.prototype.paint.call(this);
  if (this.isFocused) {
    this._ncWindow.bkgd = ' ' | ncurses.colorPair(Colors.TEXTENTRY);
    this._ncWindow.attroff(ncurses.colorPair(Colors.NORMAL));
    this._ncWindow.attron(ncurses.colorPair(Colors.TEXTENTRY));
  } else {
    this._ncWindow.bkgd = ' ' | ncurses.colorPair(Colors.NORMAL);
    this._ncWindow.attroff(ncurses.colorPair(Colors.TEXTENTRY));
    this._ncWindow.attron(ncurses.colorPair(Colors.NORMAL));
  }
  this.paintTextBuffer();
  this._ncWindow.cursor(0, 0);
  this._ncWindow.addstr(this.textBuffer, this.textBuffer.length + this.cursorOffset);
}

TextBoxControl.prototype.focus = function (callback) {
  this.top();
  if (!this.isFocused) {
    this.isFocused = true;
    this.paint();
  }
  if (callback) {
    callback();
  }
  this.emit('focus');
}

TextBoxControl.prototype.blur = function (callback) {
  this.isFocused = false;
  this.paint();
  if (callback) {
    callback();
  }
  this.emit('blur');
}

TextBoxControl.prototype.show = function (callback) {
  this.paint();
  ControlWindow.prototype.show.call(this, callback);
}

TextBoxControl.prototype.top = function () {
  this._ncWindow.top();
}

TextBoxControl.prototype.showOnTop = function (callback) {
  var context = this;
  var __onTextBoxShowComplete = function () {
    callback.call(context);
    context.top(); // do this after the callback to make sure the control is on top
  };
  this.show(__onTextBoxShowComplete);
}

TextBoxControl.prototype.insertAtCursorWithOffset = function (text) {
  var leftstr = this.textBuffer.substr(0, this.textBuffer.length + this.cursorOffset);
  var rightstr = this.textBuffer.substr(this.textBuffer.length + this.cursorOffset);
  this.textBuffer = leftstr + text + rightstr;
  this.paintTextBuffer();
  this._ncWindow.cursor(0, 0);
  this._ncWindow.addstr(this.textBuffer, leftstr.length + text.length);
  this._ncWindow.refresh();
}

TextBoxControl.prototype.splitLineToLimit = function (line, limit) {
  var ret = [line];
  while (ret[ret.length - 1].length > limit) {
    var wholeline = ret[ret.length - 1].substr(0, limit);
    var rest = ret[ret.length - 1].substr(limit);
    ret[ret.length - 1] = wholeline;
    ret.push(rest);
  }
  return ret;
}

TextBoxControl.prototype.splitTextBufferToLines = function (lines) {
  lines = lines || this.textBuffer.split("\n");
  for (var each in lines) {
    if (each != lines.length - 1) {
      lines[each] += "\n";
    }
  }
  for (var each in lines) {
    if (lines[each].length >= this._ncWindow.maxy) {
      var args = this.splitLineToLimit(lines[each], this._ncWindow.maxx + 1);
      args.unshift(1);
      args.unshift(each);
      Array.prototype.splice.apply(lines, args);
    }
  }
  return lines;
}

TextBoxControl.prototype.moveCursorLeft = function () {
  if (this.textBuffer.length + this.cursorOffset > 0) {
    this.cursorOffset--;
    if (this._ncWindow.curx > 0) {
      this._ncWindow.cursor(this._ncWindow.cury, this._ncWindow.curx - 1);
    } else {
      this._ncWindow.cursor(0, 0);
      this._ncWindow.addstr(this.textBuffer, this.textBuffer.length + this.cursorOffset);
    }
    this._ncWindow.refresh();
  }
}

TextBoxControl.prototype.moveCursorRight = function () {
  if (this._ncWindow.curx == this._ncWindow.maxx && this._ncWindow.cury == this._ncWindow.maxy) {
    if (this.cursorOffset < 0) {
      // this is *theoretically* a valid move, if resize is supported -- so emit resize event here
      if (this.increaseWindowLinesByOne()) {
        this._ncWindow.cursor(this._ncWindow.cury + 1, 0);
        this.cursorOffset++;
        this._ncWindow.refresh();
      }
    }
  } else if (this.cursorOffset < 0) {
    if (this._ncWindow.cury == this._ncWindow.maxy
        && this.textBuffer[this.textBuffer.length + this.cursorOffset] == "\n") {
      // this should be a resize event -- there's text left in the buffer and moving off the right end of text
      if (this.increaseWindowLinesByOne()) {
        this._ncWindow.cursor(this._ncWindow.cury + 1, 0);
        this.cursorOffset++;
        this._ncWindow.refresh();
      }
    } else {
      this.cursorOffset++;
      if (this._ncWindow.curx == this._ncWindow.maxx) {
        this._ncWindow.cursor(this._ncWindow.cury + 1, 0);
      } else if (this.textBuffer[this.textBuffer.length - 1 + this.cursorOffset] == "\n") {
        this._ncWindow.cursor(this._ncWindow.cury + 1, 0);
      } else {
        this._ncWindow.cursor(this._ncWindow.cury, this._ncWindow.curx + 1);
      }
      this._ncWindow.refresh();
    }
  }
}

TextBoxControl.prototype.moveCursorVertically = function (byHowMuch) {
  var singleMoveDown = byHowMuch == 1;
  var singleMoveUp = byHowMuch == -1;
  if (byHowMuch != 0) {
    if (byHowMuch > 1 || byHowMuch < -1) {
      if (this._ncWindow.cury + byHowMuch < 0) {
        byHowMuch = -this._ncWindow.cury;
      } else if (this._ncWindow.cury + byHowMuch > this._ncWindow.maxy) {
        byHowMuch = this._ncWindow.maxy - this._ncWindow.cury;
      }
    }
    if (this._ncWindow.cury + byHowMuch >= 0 && this._ncWindow.cury + byHowMuch <= this._ncWindow.maxy) {
      var lines = this.textBuffer.split("\n");
      var nNewlines = lines.length - 1;
      lines = this.splitTextBufferToLines(lines);
      if (singleMoveDown && this._ncWindow.cury + 1 == lines.length) {
        // case: moving down past the bottom of the box (past the end of the text)
        this.emit('leaveDown');
      } else if (singleMoveUp && this._ncWindow.cury - 1 == lines.length) {
        // case: moving up and somehow (?) past the bottom of the text (this should never happen)
        this.emit('leaveDown');
      } else {
        if (this._ncWindow.cury + byHowMuch + 1 > lines.length) {
          byHowMuch = lines.length - this._ncWindow.cury - 1;
        }
        var targetLine = lines[this._ncWindow.cury + byHowMuch];
        var newLineOffset = targetLine[targetLine.length - 1] != "\n" ? 0 : 1;
        if (this._ncWindow.curx > targetLine.length - newLineOffset) {
          var basex = targetLine.length - newLineOffset;
          this._ncWindow.cursor(this._ncWindow.cury + byHowMuch, basex);
        } else {
          this._ncWindow.cursor(this._ncWindow.cury + byHowMuch, this._ncWindow.curx);
        }
        var i = 0, forwardCursor = 0;
        for (i = 0; i < this._ncWindow.cury; i++) {
          forwardCursor += lines[i].length;
        }
        this.cursorOffset = forwardCursor + this._ncWindow.curx - this.textBuffer.length;
        this._ncWindow.refresh();
      }
    } else {
      // trying to move outside the box
      if (singleMoveUp || (byHowMuch < 0 && this._ncWindow.cury == 0)) {
        this.emit('leaveUp');
      } else if (singleMoveDown || (byHowMuch > 1 && this._ncWindow.cury == this._ncWindow.maxy)) {
        this.emit('leaveDown');
      } else {
        ncurses.flash();
      }
    }
  }
}

TextBoxControl.prototype.deleteCharacterBeforeCursor = function () {
  if (this.textBuffer.length + this.cursorOffset > 0) {
    var charDeleted = this.textBuffer[this.textBuffer.length + this.cursorOffset - 1];
    if (this.cursorOffset == 0) {
      this.textBuffer = this.textBuffer.substr(0, this.textBuffer.length - 1);
      if (charDeleted == "\n") {
        this.paintTextBuffer(); // it's just easier this way
      } else {
        if (this._ncWindow.curx > 0) { 
          this._ncWindow.cursor(this._ncWindow.cury, this._ncWindow.curx - 1);
          this._ncWindow.addstr(" ");
          this._ncWindow.cursor(this._ncWindow.cury, this._ncWindow.curx - 1);
        } else {
          this._ncWindow.cursor(this._ncWindow.cury - 1, this._ncWindow.maxx);
          this._ncWindow.addstr(" ");
          this._ncWindow.cursor(this._ncWindow.cury - 1, this._ncWindow.maxx);
        }
        this._ncWindow.refresh();
      }
    } else {
      var leftstr = this.textBuffer.substr(0, this.textBuffer.length - 1 + this.cursorOffset);
      var rightstr = this.textBuffer.substr(this.textBuffer.length + this.cursorOffset);
      this.textBuffer = leftstr + rightstr;
      this.paintTextBuffer();
      this._ncWindow.cursor(0, 0);
      this._ncWindow.addstr(this.textBuffer, leftstr.length);
      this._ncWindow.refresh();
    }
  } else {
    // backspacing at the beginning
  }
}

TextBoxControl.prototype.deleteCharacterAtCursor = function () {
  if (this.cursorOffset < 0) {
    var leftstr = this.textBuffer.substr(0, this.textBuffer.length + this.cursorOffset);
    var rightstr = this.textBuffer.substr(this.textBuffer.length + 1 + this.cursorOffset);
    this.textBuffer = leftstr + rightstr;
    this.paintTextBuffer();
    this._ncWindow.cursor(0, 0);
    this._ncWindow.addstr(this.textBuffer, leftstr.length);
    if (this._ncWindow.cury == this._ncWindow.maxy && this._ncWindow.curx == this._ncWindow.maxx) {
      if (this.cursorOffset == -1) {
        var save_cury = this._ncWindow.cury;
        var save_curx = this._ncWindow.curx;
        this._ncWindow.addstr(" ");
        this._ncWindow.cursor(save_cury, save_curx);
      }
    }
    this.cursorOffset++;
    this._ncWindow.refresh();
  } else {
    // deleting at the end
  }
}

TextBoxControl.prototype.insertNewLineAtCursor = function () {
  var __TBCQuickAppendNewLine = function () {
    this.textBuffer += "\n";
    this._ncWindow.cursor(this._ncWindow.cury + 1, 0);
    this._ncWindow.refresh();
  };
  if (this._ncWindow.cury != this._ncWindow.maxy) {
    if (this.cursorOffset == 0) {
      __TBCQuickAppendNewLine.call(this);
    } else {
      var lines = this.splitTextBufferToLines();
      if (lines.length - 1 < this._ncWindow.maxy) {
        this.insertAtCursorWithOffset("\n");
      } else {
        // can't insert a new line -- max lines have been hit (resize event?)
        if (this.increaseWindowLinesByOne(lines)) {
          this.insertAtCursorWithOffset("\n");
        }
      }
    }
  } else {
    // trying to hit enter past the bottom of the window
    if (this.increaseWindowLinesByOne()) {
      if (this.cursorOffset == 0) {
        __TBCQuickAppendNewLine.call(this);
      } else {
        this.insertAtCursorWithOffset("\n");
      }
    }
  }
}

TextBoxControl.prototype.moveCursorToEndOfBuffer = function () {
  this.paintTextBuffer();
  this.cursorOffset = 0;
  if (this._ncWindow.curx == this._ncWindow.maxx && this._ncWindow.cury == this._ncWindow.maxy) {
    var lines = this.splitTextBufferToLines();
    if (lines[lines.length - 1].length - 1 >= this._ncWindow.maxx) {
      // this should be considered a resize event
      if (this.increaseWindowLinesByOne(lines)) {
        this.paintTextBuffer();
        this.cursorOffset = 0;
      } else {
        this.cursorOffset = this._ncWindow.maxx - lines[lines.length - 1].length;
      }
    }
  } else if (this._ncWindow.cury == this._ncWindow.maxy) {
    var lines = this.splitTextBufferToLines();
    if (lines.length > this._ncWindow.maxy + 1 && lines[lines.length - 1].length == 0) {
      // similar case as the one above, just if the final character is a newline (resize event)
      if (this.increaseWindowLinesByOne(lines)) {
        this.paintTextBuffer();
        this.cursorOffset = 0;
      } else {
        this.cursorOffset = this._ncWindow.maxy + 1 - lines.length;
      }
    }
  }
  this._ncWindow.refresh();
}

TextBoxControl.prototype.increaseWindowLinesByOne = function (lines) {
  var didResizeHappen = false;
  lines = lines || this.splitTextBufferToLines();
  if (this.allowResize && (this.maxLinesAllowed <= 0 || lines.length < this.maxLinesAllowed)) {
    this._ncWindow.resize(this._ncWindow.maxy + 2, this._ncWindow.maxx + 1);
    this.emit('resize');
    didResizeHappen = true;
  }
  return didResizeHappen;
}

TextBoxControl.prototype.respondToKeyPress = function (chunk, key) {
  if (key && key.name == "backspace") {
    this.deleteCharacterBeforeCursor();
  } else if (key && key.name == "delete") {
    this.deleteCharacterAtCursor();
  } else if (key && key.name == "enter") {
    this.insertNewLineAtCursor();
  } else if (key && key.name == "end") {
    this.moveCursorToEndOfBuffer();
  } else if (key && key.name == "left") {
    this.moveCursorLeft();
  } else if (key && key.name == "right") {
    this.moveCursorRight();
  } else if (key && key.name == "up") {
    this.moveCursorVertically(-1);
  } else if (key && key.name == "down") {
    this.moveCursorVertically(1);
  } else if (chunk && !(key && (key.ctrl || key.meta)) && !/[\x00-\x1F]/.test(chunk)) {
    if (this.cursorOffset == 0) {
      var __TBCQuickAppendChunk = function (chunk) {
        this.textBuffer += chunk;
        this._ncWindow.addstr(chunk);
        this._ncWindow.refresh();
      };
      if (this._ncWindow.curx == this._ncWindow.maxx && this._ncWindow.cury == this._ncWindow.maxy) {
        // trying to type off the end of the box, resize event?
        if (this.increaseWindowLinesByOne()) {
          __TBCQuickAppendChunk.call(this, chunk);
        }
      } else {
        __TBCQuickAppendChunk.call(this, chunk);
      }
    } else {
      var lines = this.splitTextBufferToLines();
      if (lines.length - 1 < this._ncWindow.maxy) {
        this.insertAtCursorWithOffset(chunk);
      } else if (lines.length - 1 == this._ncWindow.maxy
                 && lines[this._ncWindow.cury].length - 1 < this._ncWindow.maxx) {
        this.insertAtCursorWithOffset(chunk);
      } else if (lines.length - 1 == this._ncWindow.maxy) {
        var isSpaceLeft = false;
        var i = this._ncWindow.cury + 1;
        for (; i < this._ncWindow.maxy; i++) {
          if (lines[i].length < this._ncWindow.maxx && lines[i-1][lines[i-1].length-1] != "\n") {
            isSpaceLeft = true;
            break;
          }
        }
        if (isSpaceLeft) {
          this.insertAtCursorWithOffset(chunk);
        } else {
          // trying to push characters off the end of the box, resize event?
          if (this.increaseWindowLinesByOne()) {
            this.insertAtCursorWithOffset(chunk);
          }
        }
      }
    }
  }
}

function LogMessageWindow(lines, cols, begy, begx) {
  var context = this;
  AppWindow.prototype.constructor.call(this, lines, cols, begy, begx);
  this._ncWindow.cursor(1, 1);
  this.textBox = new TextBoxControl(5, this._ncWindow.maxx - 1, 3, 1);
  this.textBox.allowResize = true;
  this.textBox.maxLinesAllowed = 9;
  /*this.textBox.on('leaveDown', function () {
    context.textBox.blur();
  });*/
}
util.inherits(LogMessageWindow, AppWindow);

LogMessageWindow.prototype.paint = function () {
  var save_cury = this._ncWindow.cury;
  var save_curx = this._ncWindow.curx;
  AppWindow.prototype.paint.call(this);
  this._ncWindow.cursor(this.textBox._ncWindow.begy - 1, this.textBox._ncWindow.begx);
  this._ncWindow.addstr("Log Message:");
  if (this.textBox.isFocused) {
    this.textBox.top();
  } else {
    this._ncWindow.cursor(3, 1);
    var lines = this.textBox.splitTextBufferToLines();
    for (var each in lines) {
      if (lines[each][lines[each].length - 1] == '\n') {
        this._ncWindow.addstr(lines[each], lines[each].length - 1);
      } else {
        this._ncWindow.addstr(lines[each]);
      }
      this._ncWindow.cursor(this._ncWindow.cury + 1, 1);
    }
  }
  this._ncWindow.cursor(save_cury, save_curx);
}

LogMessageWindow.prototype.respondToKeyPress = function (chunk, key) {
  AppWindow.prototype.respondToKeyPress.call(this, chunk, key);
  if (this.textBox.isFocused) {
    this.textBox.respondToKeyPress(chunk, key);
  }
}

LogMessageWindow.prototype.show = function (callback) {
  var context = this;
  var __LMWOnTextBoxShowComplete = function () {
    AppWindow.prototype.show.call(context, callback);
  };
  this.textBox.showOnTop(__LMWOnTextBoxShowComplete);
}

LogMessageWindow.prototype.hide = function () {
  this.textBox.hide();
  AppWindow.prototype.hide.call(this);
}

LogMessageWindow.prototype.close = function (callback) {
  var context = this;
  var __closeLogMessageWindow = function () {
    AppWindow.prototype.close.call(context, callback);
  };
  this.textBox.close(__closeLogMessageWindow);
}

Application.start();

process.stdin.on('keypress', function (chunk, key) {
  Application.respondToKeyPress(chunk, key);
});

/*process.stdin.on('data', function (data) {
  Application.respondToData(data);
});*/

process.on('SIGINT', function () {
  Application.close("process caught SIGINT, exiting");
});

process.on('SIGWINCH', function () {
  Application.close("resize not yet supported");
});
