import {
  Box,
  Flex,
  HStack,
  Icon,
  IconButton,
  Spacer,
  Text,
  useToast,
} from "@chakra-ui/react";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { MdKeyboard, MdKeyboardHide } from "react-icons/md";
import { VscChevronRight, VscFolderOpened, VscGist } from "react-icons/vsc";
import useLocalStorageState from "use-local-storage-state";

import rustpadRaw from "../rustpad-server/src/rustpad.rs?raw";
import Footer from "./Footer";
import ReadCodeConfirm from "./ReadCodeConfirm";
import Sidebar, { WordWrap } from "./Sidebar";
import animals from "./animals.json";
import {
  createEditor,
  setEditorDarkMode,
  setEditorLanguage,
  setEditorWrap,
} from "./editor";
import languages from "./languages.json";
import Rustpad, { UserInfo } from "./rustpad";
import useHash from "./useHash";

function getWsUri(id: string) {
  let url = new URL(`api/socket/${id}`, window.location.href);
  url.protocol = url.protocol == "https:" ? "wss:" : "ws:";
  return url.href;
}

function generateName() {
  return "Anonymous " + animals[Math.floor(Math.random() * animals.length)];
}

function generateHue() {
  return Math.floor(Math.random() * 360);
}

function getStoredName(id: string) {
  try {
    const stored = window.localStorage.getItem(`name:${id}`);
    return stored === null ? generateName() : JSON.parse(stored);
  } catch {
    return generateName();
  }
}

/** Touch screens, where the on-screen keyboard has no button of its own to hide it. */
const touchScreen = window.matchMedia("(pointer: coarse)").matches;

function App() {
  const toast = useToast();
  const id = useHash();
  const [language, setLanguage] = useState("plaintext");
  const [connection, setConnection] = useState<
    "connected" | "disconnected" | "desynchronized"
  >("disconnected");
  const [users, setUsers] = useState<Record<number, UserInfo>>({});
  const [name, setName] = useState(() => getStoredName(id));
  const [hue, setHue] = useLocalStorageState("hue", {
    defaultValue: generateHue,
  });
  const [editor, setEditor] = useState<EditorView>();
  const editorParent = useRef<HTMLDivElement>(null);
  const [editorFocused, setEditorFocused] = useState(false);
  const [darkMode, setDarkMode] = useLocalStorageState("darkMode", {
    defaultValue: false,
  });
  const [wordWrap, setWordWrap] = useLocalStorageState<WordWrap>("wordWrap", {
    defaultValue: "on",
  });
  // Monaco's "wordWrapColumn" and "bounded", stored by earlier versions, wrap.
  const currentWordWrap: WordWrap = wordWrap === "off" ? "off" : "on";
  const rustpad = useRef<Rustpad>();

  const [readCodeConfirmOpen, setReadCodeConfirmOpen] = useState(false);

  useEffect(() => {
    setName(getStoredName(id));
  }, [id]);

  function handleNameChange(name: string) {
    if (name.length > 0) {
      setName(name);
      window.localStorage.setItem(`name:${id}`, JSON.stringify(name));
    }
  }

  useEffect(() => {
    const view = createEditor(editorParent.current!);
    setEditor(view);
    return () => view.destroy();
  }, []);

  useEffect(() => {
    if (!editor) return;
    const content = editor.contentDOM;
    const onFocus = () => setEditorFocused(true);
    const onBlur = () => setEditorFocused(false);
    content.addEventListener("focus", onFocus);
    content.addEventListener("blur", onBlur);
    return () => {
      content.removeEventListener("focus", onFocus);
      content.removeEventListener("blur", onBlur);
    };
  }, [editor]);

  function handleKeyboardToggle() {
    if (!editor) return;
    if (editorFocused) editor.contentDOM.blur();
    else editor.focus();
  }

  useEffect(() => {
    if (editor) setEditorLanguage(editor, language);
  }, [editor, language]);

  useEffect(() => {
    if (editor) setEditorDarkMode(editor, darkMode);
  }, [editor, darkMode]);

  useEffect(() => {
    if (editor) {
      setEditorWrap(editor, currentWordWrap === "on", language === "markdown");
    }
  }, [editor, currentWordWrap, language]);

  useEffect(() => {
    if (editor) {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: "" },
      });
      rustpad.current = new Rustpad({
        uri: getWsUri(id),
        editor,
        onConnected: () => setConnection("connected"),
        onDisconnected: () => setConnection("disconnected"),
        onDesynchronized: () => {
          setConnection("desynchronized");
          toast({
            title: "Desynchronized with server",
            description: "Please save your work and refresh the page.",
            status: "error",
            duration: null,
          });
        },
        onChangeLanguage: (language) => {
          if (languages.includes(language)) {
            setLanguage(language);
          }
        },
        onChangeUsers: setUsers,
      });
      return () => {
        rustpad.current?.dispose();
        rustpad.current = undefined;
      };
    }
  }, [id, editor, toast, setUsers]);

  useEffect(() => {
    if (connection === "connected") {
      rustpad.current?.setInfo({ name, hue });
    }
  }, [connection, name, hue]);

  function handleLanguageChange(language: string) {
    setLanguage(language);
    if (rustpad.current?.setLanguage(language)) {
      toast({
        title: "Language updated",
        description: (
          <>
            All users are now editing in{" "}
            <Text as="span" fontWeight="semibold">
              {language}
            </Text>
            .
          </>
        ),
        status: "info",
        duration: 2000,
        isClosable: true,
      });
    }
  }

  function handleLoadSample(confirmed: boolean) {
    if (editor) {
      // If there are at least 10 lines of code, ask for confirmation.
      if (editor.state.doc.lines >= 10 && !confirmed) {
        setReadCodeConfirmOpen(true);
        return;
      }

      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: rustpadRaw },
        selection: { anchor: 0 },
      });
      if (language !== "rust") {
        handleLanguageChange("rust");
      }
    }
  }

  function handleDarkModeChange() {
    setDarkMode(!darkMode);
  }

  return (
    <Flex
      direction="column"
      h="100vh"
      overflow="hidden"
      bgColor={darkMode ? "#1e1e1e" : "white"}
      color={darkMode ? "#cbcaca" : "inherit"}
    >
      <Box
        flexShrink={0}
        bgColor={darkMode ? "#333333" : "#e8e8e8"}
        color={darkMode ? "#cccccc" : "#383838"}
        textAlign="center"
        fontSize="sm"
        py={0.5}
      >
        Rustpad
      </Box>
      <Flex flex="1 0" minH={0}>
        <Sidebar
          documentId={id}
          connection={connection}
          darkMode={darkMode}
          language={language}
          currentUser={{ name, hue }}
          users={users}
          onDarkModeChange={handleDarkModeChange}
          wordWrap={currentWordWrap}
          onWordWrapChange={setWordWrap}
          onLanguageChange={handleLanguageChange}
          onLoadSample={() => handleLoadSample(false)}
          onChangeName={handleNameChange}
          onChangeColor={() => setHue(generateHue())}
        />
        <ReadCodeConfirm
          isOpen={readCodeConfirmOpen}
          onClose={() => setReadCodeConfirmOpen(false)}
          onConfirm={() => {
            handleLoadSample(true);
            setReadCodeConfirmOpen(false);
          }}
        />

        <Flex flex={1} minW={0} h="100%" direction="column" overflow="hidden">
          <HStack
            h={6}
            spacing={1}
            color="#888888"
            fontWeight="medium"
            fontSize="13px"
            px={3.5}
            flexShrink={0}
          >
            <Icon as={VscFolderOpened} fontSize="md" color="blue.500" />
            <Text>documents</Text>
            <Icon as={VscChevronRight} fontSize="md" />
            <Icon as={VscGist} fontSize="md" color="purple.500" />
            <Text>{id}</Text>
            {touchScreen && (
              <>
                <Spacer />
                <IconButton
                  aria-label={editorFocused ? "Hide keyboard" : "Show keyboard"}
                  icon={editorFocused ? <MdKeyboardHide /> : <MdKeyboard />}
                  size="xs"
                  fontSize="lg"
                  variant="ghost"
                  color="#888888"
                  // Keep the editor focused through the tap; the click decides.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={handleKeyboardToggle}
                />
              </>
            )}
          </HStack>
          <Box flex={1} minH={0} ref={editorParent} />
        </Flex>
      </Flex>
      <Footer />
    </Flex>
  );
}

export default App;
