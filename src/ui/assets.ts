import { accessClientScript } from './client/access';
import { apiClientScript } from './client/api';
import { formsClientScript } from './client/forms';
import { styles } from './styles';

export const UI_CSS = styles;
export const UI_JS = [apiClientScript, accessClientScript, formsClientScript].join('\n');
