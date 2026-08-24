/**
 * The plate map.
 *
 * A microplate is a spatial object, and a list of well names is a poor way to
 * find B7. Drawing the plate as it looks on the bench — row letters down the
 * side, column numbers across the top, imaged positions filled in — makes the
 * shape of an experiment visible at a glance: which columns were used, whether
 * a row was skipped, where the controls are.
 *
 * It is also the answer to the one real cost in this viewer. Opening a whole
 * plate reads a slice of the entire acquisition; opening one well reads almost
 * nothing. Clicking a well is both the obvious gesture and the cheap one.
 */
import { wellName } from '../yokogawa/plate';
import type { PlateModel, Well } from '../yokogawa/types';

export interface PlateMap {
  element: HTMLElement;
  /** Highlight one well, or none. */
  setCurrent(wellId: string | null): void;
}

/**
 * Render a plate map into `container`, calling `onSelect` when a well is
 * clicked. Positions that were not imaged are drawn but inert.
 */
export function renderPlateMap(
  container: HTMLElement,
  model: PlateModel,
  onSelect: (well: Well) => void,
): PlateMap {
  const { rows, columns } = model.plate;
  const imaged = new Map(model.wells.map((well) => [`${well.row}/${well.column}`, well]));
  const buttons = new Map<string, HTMLButtonElement>();

  container.replaceChildren();
  container.style.setProperty('--columns', String(columns));

  // A 384-well plate has no room for `AA13` inside a 14 px circle, and the row
  // and column headers already say which well it is.
  const labelled = rows * columns <= 96;

  const label = (text: string): HTMLElement => {
    const element = document.createElement('span');
    element.className = 'plate-label';
    element.textContent = text;
    element.setAttribute('aria-hidden', 'true');
    return element;
  };

  container.append(label(''));
  for (let column = 0; column < columns; column += 1) container.append(label(String(column + 1)));

  for (let row = 0; row < rows; row += 1) {
    container.append(label(wellName(row, 0).replace(/\d+$/, '')));
    for (let column = 0; column < columns; column += 1) {
      const well = imaged.get(`${row}/${column}`);
      if (!well) {
        const empty = document.createElement('span');
        empty.className = 'well';
        container.append(empty);
        continue;
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'well is-imaged';
      button.textContent = labelled ? well.id : '';
      button.title = `${well.id} — ${well.tiles.length} field${
        well.tiles.length === 1 ? '' : 's'
      }, ${well.sizeZ} z plane${well.sizeZ === 1 ? '' : 's'}`;
      button.setAttribute('aria-label', `Open well ${well.id}`);
      button.addEventListener('click', () => onSelect(well));
      buttons.set(well.id, button);
      container.append(button);
    }
  }

  return {
    element: container,
    setCurrent(wellId) {
      for (const [id, button] of buttons) {
        button.classList.toggle('is-current', id === wellId);
      }
    },
  };
}
