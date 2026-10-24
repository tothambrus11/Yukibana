<?php

// Replaces Phpactor's ClassToFileNameToUriConverter (lib/Rename/Adapter/
// ClassToFile/ClassToFileNameToUriConverter.php), which tells the class
// renamer which file the renamed class will live in. Upstream asks the
// project's class-to-file map: Composer's autoloader, or, without one, a
// search for a file named after the class. Before the rename, no file is
// named after the new name, and the project has no vendor/autoload.php, so
// every class rename failed with "There are no file path candidates" (the
// error went to window/showMessage and the client got an empty edit).
//
// This one asks the same map first, and otherwise answers where PSR-4 would
// put the class under the project root (Geometry\Pt: Geometry/Pt.php).
// The answer only names the file in the RenameFile operation Phpactor adds
// to the rename's edit, and server.js drops that operation (the editor
// cannot move files during a rename, and the project's files need not
// follow PSR-4), so the class is renamed in place, in every file.
//
// Why not give Phpactor a Composer map instead: the same loader would also
// decide which class a file should declare. With a PSR-4 root over the
// project, every file not laid out as PSR-4 (geometry.php declaring Point)
// gets "Class name should probably be "geometry"" and the code action that
// renames the class to that, and every unknown class offers to create a file
// the editor cannot create. A class map would have to be rebuilt as files
// change, and Phpactor reads it once, at start.
//
// The class has upstream's name, constructor and method, so the extension
// that constructs it uses it unchanged. It must be loaded before Composer's
// autoloader would load upstream's (phpactor.php).

namespace Phpactor\Rename\Adapter\ClassToFile;

use Phpactor\ClassFileConverter\Domain\ClassName;
use Phpactor\ClassFileConverter\Domain\ClassToFile;
use Phpactor\Rename\Model\NameToUriConverter;
use Phpactor\TextDocument\TextDocumentUri;
use RuntimeException;

class ClassToFileNameToUriConverter implements NameToUriConverter
{
    public function __construct(private ClassToFile $classToFile)
    {
    }

    public function convert(string $className): TextDocumentUri
    {
        try {
            return TextDocumentUri::fromString($this->classToFile->classToFileCandidates(ClassName::fromString($className))->best());
        } catch (RuntimeException) {
            // The working directory is the project root (server.js).
            return TextDocumentUri::fromString(getcwd() . '/' . str_replace('\\', '/', ltrim($className, '\\')) . '.php');
        }
    }
}
