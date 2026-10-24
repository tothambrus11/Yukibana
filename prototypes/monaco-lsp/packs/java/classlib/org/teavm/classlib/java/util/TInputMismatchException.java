/*
 *  Yukibana Java pack: java.util.InputMismatchException, which TScanner
 *  throws and TeaVM's class library (0.16.0) does not have.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */
package org.teavm.classlib.java.util;

public class TInputMismatchException extends TNoSuchElementException {
    public TInputMismatchException() {
    }

    public TInputMismatchException(String message) {
        super(message);
    }
}
