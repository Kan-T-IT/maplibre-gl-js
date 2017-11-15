// @flow

const assert = require('assert');
const {extend, easeCubicInOut} = require('../util/util');
const interpolate = require('../style-spec/util/interpolate');
const {RGBAImage} = require('../util/image');
const {normalizePropertyExpression} = require('../style-spec/expression');
const Color = require('../style-spec/util/color');

import type {StylePropertySpecification} from '../style-spec/style-spec';
import type {CrossFaded} from './cross_faded';
import type {ZoomHistory} from './style';

import type {
    Feature,
    GlobalProperties,
    StylePropertyExpression,
    SourceExpression,
    CompositeExpression
} from '../style-spec/expression';

type TimePoint = number;

export type EvaluationParameters = GlobalProperties & {
    now?: TimePoint,
    defaultFadeDuration?: number,
    zoomHistory?: ZoomHistory
};

/**
 * Implements a number of classes that define state and behavior for paint and layout properties, most
 * importantly their respective evaluation chains:
 *
 *       Transitionable paint property value
 *     → Transitioning paint property value
 *     → Possibly evaluated paint property value
 *     → Fully evaluated paint property value
 *
 *       Layout property value
 *     → Possibly evaluated layout property value
 *     → Fully evaluated layout property value
 *
 * @module
 * @private
 */

/**
 *  Implementations of the `Property` interface:
 *
 *  * Hold metadata about a property that's independent of any specific value: stuff like the type of the value,
 *    the default value, etc. This comes from the style specification JSON.
 *  * Define behavior that needs to be polymorphic across different properties: "possibly evaluating"
 *    an input value (see below), and interpolating between two possibly-evaluted values.
 *
 *  The type `T` is the fully-evaluated value type (e.g. `number`, `string`, `Color`).
 *  The type `R` is the intermediate "possibly evaluated" value type. See below.
 *
 *  There are two main implementations of the interface -- one for properties that allow data-driven values,
 *  and one for properties that don't. There are a few "special case" implementations as well: one for properties
 *  which cross-fade between two values rather than interpolating, one for `heatmap-color`, and one for
 *  `light-position`.
 *
 * @private
 */
export interface Property<T, R> {
    specification: StylePropertySpecification;
    possiblyEvaluate(value: PropertyValue<T, R>, parameters: EvaluationParameters): R;
    interpolate(a: R, b: R, t: number): R;
}

/**
 *  `PropertyValue` represents the value part of a property key-value unit. It's used to represent both
 *  paint and layout property values, and regardless of whether or not their property supports data-driven
 *  expressions.
 *
 *  `PropertyValue` stores the raw input value as seen in a style or a runtime styling API call, i.e. one of the
 *  following:
 *
 *    * A constant value of the type appropriate for the property
 *    * A function which produces a value of that type (but functions are quasi-deprecated in favor of expressions)
 *    * An expression which produces a value of that type
 *    * "undefined"/"not present", in which case the property is assumed to take on its default value.
 *
 *  In addition to storing the original input value, `PropertyValue` also stores a normalized representation,
 *  effectively treating functions as if they are expressions, and constant or default values as if they are
 *  (constant) expressions.
 *
 *  @private
 */
class PropertyValue<T, R> {
    property: Property<T, R>;
    value: PropertyValueSpecification<T> | void;
    expression: StylePropertyExpression;

    constructor(property: Property<T, R>, value: PropertyValueSpecification<T> | void) {
        this.property = property;
        this.value = value;
        this.expression = normalizePropertyExpression(value === undefined ? property.specification.default : value, property.specification);
    }

    isDataDriven(): boolean {
        return this.expression.kind === 'source' || this.expression.kind === 'composite';
    }

    possiblyEvaluate(parameters: EvaluationParameters): R {
        return this.property.possiblyEvaluate(this, parameters);
    }
}

// ------- Transitionable -------

type TransitionParameters = {
    now: TimePoint,
    transition: TransitionSpecification
};

/**
 * Paint properties are _transitionable_: they can change in a fluid manner, interpolating or cross-fading between
 * old and new value. The duration of the transition, and the delay before it begins, is configurable.
 *
 * `TransitionablePropertyValue` is a compositional class that stores both the property value and that transition
 * configuration.
 *
 * A `TransitionablePropertyValue` can calculate the next step in the evaluation chain for paint property values:
 * `TransitioningPropertyValue`.
 *
 * @private
 */
class TransitionablePropertyValue<T, R> {
    property: Property<T, R>;
    value: PropertyValue<T, R>;
    transition: TransitionSpecification | void;

    constructor(property: Property<T, R>) {
        this.property = property;
        this.value = new PropertyValue(property, undefined);
    }

    transitioned(parameters: TransitionParameters,
                 prior: TransitioningPropertyValue<T, R>): TransitioningPropertyValue<T, R> {
        return new TransitioningPropertyValue(this.property, this.value, prior, // eslint-disable-line no-use-before-define
            extend({}, this.transition, parameters.transition), parameters.now);
    }

    untransitioned(): TransitioningPropertyValue<T, R> {
        return new TransitioningPropertyValue(this.property, this.value, null, {}, 0); // eslint-disable-line no-use-before-define
    }
}

/**
 * A helper type: given an object type `Properties` whose values are each of type `Property<T, R>`, it calculates
 * an object type with the same keys and values of type `TransitionablePropertyValue<T, R>`.
 *
 * @private
 */
type TransitionablePropertyValues<Properties: Object>
    = $Exact<$ObjMap<Properties, <T, R>(p: Property<T, R>) => TransitionablePropertyValue<T, R>>>

/**
 * `Transitionable` stores a map of all (property name, `TransitionablePropertyValue`) pairs for paint properties of a
 * given layer type. It can calculate the `TransitioningPropertyValue`s for all of them at once, producing a
 * `Transitioning` instance for the same set of properties.
 *
 * @private
 */
class Transitionable<Properties: Object> {
    _values: TransitionablePropertyValues<Properties>;

    constructor(properties: Properties) {
        const values = this._values = ({}: any);
        for (const property in properties) {
            values[property] = new TransitionablePropertyValue(properties[property]);
        }
    }

    getValue<S: string, T>(name: S): PropertyValueSpecification<T> | void {
        return this._values[name].value.value;
    }

    setValue<S: string, T>(name: S, value: PropertyValueSpecification<T> | void) {
        this._values[name].value = new PropertyValue(this._values[name].property, value === null ? undefined : value);
    }

    getTransition<S: string>(name: S): TransitionSpecification | void {
        return this._values[name].transition;
    }

    setTransition<S: string>(name: S, value: TransitionSpecification | void) {
        this._values[name].transition = value || undefined;
    }

    serialize() {
        const result: any = {};
        for (const property in this._values) {
            const value = this.getValue(property);
            if (value !== undefined) {
                result[property] = value;
            }

            const transition = this.getTransition(property);
            if (transition !== undefined) {
                result[`${property}-transition`] = transition;
            }
        }
        return result;
    }

    transitioned(parameters: TransitionParameters, prior: Transitioning<Properties>): Transitioning<Properties> {
        const result: any = {};
        for (const property in this._values) {
            result[property] = this._values[property].transitioned(parameters, prior._values[property]);
        }
        return new Transitioning(result); // eslint-disable-line no-use-before-define
    }

    untransitioned(): Transitioning<Properties> {
        const result: any = {};
        for (const property in this._values) {
            result[property] = this._values[property].untransitioned();
        }
        return new Transitioning(result); // eslint-disable-line no-use-before-define
    }
}

// ------- Transitioning -------

/**
 * `TransitioningPropertyValue` implements the first of two intermediate steps in the evaluation chain of a paint
 * property value. In this step, transitions between old and new values are handled: as long as the transition is in
 * progress, `TransitioningPropertyValue` maintains a reference to the prior value, and interpolates between it and
 * the new value based on the current time and the configured transition duration and delay. The product is the next
 * step in the evaluation chain: the "possibly evaluated" result type `R`. See below for more on this concept.
 *
 * @private
 */
class TransitioningPropertyValue<T, R> {
    property: Property<T, R>;
    value: PropertyValue<T, R>;
    prior: ?TransitioningPropertyValue<T, R>;
    begin: TimePoint;
    end: TimePoint;

    constructor(property: Property<T, R>,
                value: PropertyValue<T, R>,
                prior: ?TransitioningPropertyValue<T, R>,
                transition: TransitionSpecification,
                now: TimePoint) {
        this.property = property;
        this.value = value;
        this.begin = now + transition.delay || 0;
        this.end = this.begin + transition.duration || 0;
        if (transition.delay || transition.duration) {
            this.prior = prior;
        }
    }

    possiblyEvaluate(parameters: EvaluationParameters): R {
        const now = parameters.now || 0;
        const finalValue = this.value.possiblyEvaluate(parameters);
        const prior = this.prior;
        if (!prior) {
            // No prior value.
            return finalValue;
        } else if (now > this.end) {
            // Transition from prior value is now complete.
            this.prior = null;
            return finalValue;
        } else if (this.value.isDataDriven()) {
            // Transitions to data-driven properties are not supported.
            // We snap immediately to the data-driven value so that, when we perform layout,
            // we see the data-driven function and can use it to populate vertex buffers.
            this.prior = null;
            return finalValue;
        } else if (now < this.begin) {
            // Transition hasn't started yet.
            return prior.possiblyEvaluate(parameters);
        } else {
            // Interpolate between recursively-calculated prior value and final.
            const t = (now - this.begin) / (this.end - this.begin);
            return this.property.interpolate(prior.possiblyEvaluate(parameters), finalValue, easeCubicInOut(t));
        }
    }
}

/**
 * A helper type: given an object type `Properties` whose values are each of type `Property<T, R>`, it calculates
 * an object type with the same keys and values of type `TransitioningPropertyValue<T, R>`.
 *
 * @private
 */
type TransitioningPropertyValues<Properties: Object>
    = $Exact<$ObjMap<Properties, <T, R>(p: Property<T, R>) => TransitioningPropertyValue<T, R>>>

/**
 * `Transitioning` stores a map of all (property name, `TransitioningPropertyValue`) pairs for paint properties of a
 * given layer type. It can calculate the possibly-evaluated values for all of them at once, producing a
 * `PossiblyEvaluated` instance for the same set of properties.
 *
 * @private
 */
class Transitioning<Properties: Object> {
    _values: TransitioningPropertyValues<Properties>;

    constructor(values: TransitioningPropertyValues<Properties>) {
        this._values = values;
    }

    possiblyEvaluate(parameters: EvaluationParameters): PossiblyEvaluated<Properties> {
        const result: any = {};
        for (const property in this._values) {
            result[property] = this._values[property].possiblyEvaluate(parameters);
        }
        return new PossiblyEvaluated(result); // eslint-disable-line no-use-before-define
    }

    hasTransition() {
        for (const property in this._values) {
            if (this._values[property].prior) {
                return true;
            }
        }
        return false;
    }
}

// ------- Layout -------

/**
 * A helper type: given an object type `Properties` whose values are each of type `Property<T, R>`, it calculates
 * an object type with the same keys and values of type `PropertyValue<T, R>`.
 *
 * @private
 */
type LayoutPropertyValues<Properties: Object>
    = $Exact<$ObjMap<Properties, <T, R>(p: Property<T, R>) => PropertyValue<T, R>>>

/**
 * Because layout properties are not transitionable, they have a simpler representation and evaluation chain than
 * paint properties: `PropertyValue`s are possibly evaluated, producing possibly evaluated values, which are then
 * fully evaluated.
 *
 * `Layout` stores a map of all (property name, `PropertyValue`) pairs for layout properties of a
 * given layer type. It can calculate the possibly-evaluated values for all of them at once, producing a
 * `PossiblyEvaluated` instance for the same set of properties.
 *
 * @private
 */
class Layout<Properties: Object> {
    _values: LayoutPropertyValues<Properties>;

    constructor(properties: Properties) {
        const values = this._values = ({}: any);
        for (const property in properties) {
            values[property] = new PropertyValue(properties[property], undefined);
        }
    }

    getValue<S: string>(name: S) {
        return this._values[name].value;
    }

    setValue<S: string>(name: S, value: *) {
        this._values[name] = new PropertyValue(this._values[name].property, value === null ? undefined : value);
    }

    serialize() {
        const result: any = {};
        for (const property in this._values) {
            const value = this.getValue(property);
            if (value !== undefined) {
                result[property] = value;
            }
        }
        return result;
    }

    possiblyEvaluate(parameters: EvaluationParameters): PossiblyEvaluated<Properties> {
        const result: any = {};
        for (const property in this._values) {
            result[property] = this._values[property].possiblyEvaluate(parameters);
        }
        return new PossiblyEvaluated(result); // eslint-disable-line no-use-before-define
    }
}

// ------- PossiblyEvaluated -------

/**
 * "Possibly evaluated value" is an intermediate stage in the evaluation chain for both paint and layout property
 * values. The purpose of this stage is to optimize away unnecessary recalculations for data-driven properties. Code
 * which uses data-driven property values must assume that the value is dependent on feature data, and request that it
 * be evaluated for each feature. But when that property value is in fact a constant or camera function, the calculation
 * will not actually depend on the feature, and we can benefit from returning the prior result of having done the
 * evaluation once, ahead of time, in an intermediate step whose inputs are just the value and "global" parameters
 * such as current zoom level.
 *
 * `PossiblyEvaluatedValue` represents the three possible outcomes of this step: if the input value was a constant or
 * camera expression, then the "possibly evaluated" result is a constant value. Otherwise, the input value was either
 * a source or composite expression, and we must defer final evaluation until supplied a feature. We separate
 * the source and composite cases because they are handled differently when generating GL attributes, buffers, and
 * uniforms.
 *
 * Note that `PossiblyEvaluatedValue` (and `PossiblyEvaluatedPropertyValue`, below) are _not_ used for properties that
 * do not allow data-driven values. For such properties, we know that the "possibly evaluated" result is always a constant
 * scalar value. See below.
 *
 * @private
 */
export type PossiblyEvaluatedValue<T> =
    | {kind: 'constant', value: T}
    | SourceExpression
    | CompositeExpression;

/**
 * `PossiblyEvaluatedPropertyValue` is used for data-driven paint and layout property values. It holds a
 * `PossiblyEvaluatedValue` and the `GlobalProperties` that were used to generate it. You're not allowed to supply
 * a different set of `GlobalProperties` when performing the final evaluation because they would be ignored in the
 * case where the input value was a constant or camera function.
 *
 * @private
 */
class PossiblyEvaluatedPropertyValue<T> {
    property: DataDrivenProperty<T>;
    value: PossiblyEvaluatedValue<T>;
    globals: GlobalProperties;

    constructor(property: DataDrivenProperty<T>, value: PossiblyEvaluatedValue<T>, globals: GlobalProperties) {
        this.property = property;
        this.value = value;
        this.globals = globals;
    }

    isConstant(): boolean {
        return this.value.kind === 'constant';
    }

    constantOr(value: T): T {
        if (this.value.kind === 'constant') {
            return this.value.value;
        } else {
            return value;
        }
    }

    evaluate(feature: Feature): T {
        return this.property.evaluate(this.value, this.globals, feature);
    }
}

/**
 * A helper type: given an object type `Properties` whose values are each of type `Property<T, R>`, it calculates
 * an object type with the same keys, and values of type `R`.
 *
 * For properties that don't allow data-driven values, `R` is a scalar type such as `number`, `string`, or `Color`.
 * For data-driven properties, it is `PossiblyEvaluatedPropertyValue`. Critically, the type definitions are set up
 * in a way that allows flow to know which of these two cases applies for any given property name, and if you attempt
 * to use a `PossiblyEvaluatedPropertyValue` as if it was a scalar, or vice versa, you will get a type error. (However,
 * there's at least one case in which flow fails to produce a type error that you should be aware of: in a context such
 * as `layer.paint.get('foo-opacity') === 0`, if `foo-opacity` is data-driven, than the left-hand side is of type
 * `PossiblyEvaluatedPropertyValue<number>`, but flow will not complain about comparing this to a number using `===`.
 * See https://github.com/facebook/flow/issues/2359.)
 *
 * There's also a third, special case possiblity for `R`: for cross-faded properties, it's `?CrossFaded<T>`.
 *
 * @private
 */
type PossiblyEvaluatedPropertyValues<Properties: Object>
    = $Exact<$ObjMap<Properties, <T, R>(p: Property<T, R>) => R>>

/**
 * `PossiblyEvaluated` stores a map of all (property name, `R`) pairs for paint or layout properties of a
 * given layer type.
 */
class PossiblyEvaluated<Properties: Object> {
    _values: PossiblyEvaluatedPropertyValues<Properties>;

    constructor(values: PossiblyEvaluatedPropertyValues<Properties>) {
        this._values = values;
    }

    get<S: string>(name: S): $ElementType<PossiblyEvaluatedPropertyValues<Properties>, S> {
        return this._values[name];
    }
}

/**
 * An implementation of `Property` for properties that do not permit data-driven (source or composite) expressions.
 * This restriction allows us to declare statically that the result of possibly evaluating this kind of property
 * is in fact always the scalar type `T`, and can be used without further evaluating the value on a per-feature basis.
 *
 * @private
 */
class DataConstantProperty<T> implements Property<T, T> {
    specification: StylePropertySpecification;

    constructor(specification: StylePropertySpecification) {
        this.specification = specification;
    }

    possiblyEvaluate(value: PropertyValue<T, T>, parameters: EvaluationParameters): T {
        assert(!value.isDataDriven());
        return value.expression.evaluate(parameters);
    }

    interpolate(a: T, b: T, t: number): T {
        const interp: ?(a: T, b: T, t: number) => T = (interpolate: any)[this.specification.type];
        if (interp) {
            return interp(a, b, t);
        } else {
            return a;
        }
    }
}

/**
 * An implementation of `Property` for properties that permit data-driven (source or composite) expressions.
 * The result of possibly evaluating this kind of property is `PossiblyEvaluatedPropertyValue<T>`; obtaining
 * a scalar value `T` requires further evaluation on a per-feature basis.
 *
 * @private
 */
class DataDrivenProperty<T> implements Property<T, PossiblyEvaluatedPropertyValue<T>> {
    specification: StylePropertySpecification;
    useIntegerZoom: boolean;

    constructor(specification: StylePropertySpecification, useIntegerZoom: boolean = false) {
        this.specification = specification;
        this.useIntegerZoom = useIntegerZoom;
    }

    possiblyEvaluate(value: PropertyValue<T, PossiblyEvaluatedPropertyValue<T>>, parameters: EvaluationParameters): PossiblyEvaluatedPropertyValue<T> {
        if (this.useIntegerZoom) {
            parameters = extend({}, parameters, {zoom: Math.floor(parameters.zoom)});
        }
        if (value.expression.kind === 'constant' || value.expression.kind === 'camera') {
            return new PossiblyEvaluatedPropertyValue(this, {kind: 'constant', value: value.expression.evaluate(parameters)}, parameters);
        } else {
            return new PossiblyEvaluatedPropertyValue(this, value.expression, parameters);
        }
    }

    interpolate(a: PossiblyEvaluatedPropertyValue<T>,
                b: PossiblyEvaluatedPropertyValue<T>,
                t: number): PossiblyEvaluatedPropertyValue<T> {
        // If either possibly-evaluated value is non-constant, give up: we aren't able to interpolate data-driven values.
        if (a.value.kind !== 'constant' || b.value.kind !== 'constant') {
            return a;
        }

        // Special case hack solely for fill-outline-color.
        if (a.value.value === undefined || a.value.value === undefined)
            return (undefined: any);

        const interp: ?(a: T, b: T, t: number) => T = (interpolate: any)[this.specification.type];
        if (interp) {
            return new PossiblyEvaluatedPropertyValue(this, {kind: 'constant', value: interp(a.value.value, b.value.value, t)}, a.globals);
        } else {
            return a;
        }
    }

    evaluate(value: PossiblyEvaluatedValue<T>, globals: GlobalProperties, feature: Feature): T {
        if (this.useIntegerZoom) {
            globals = extend({}, globals, {zoom: Math.floor(globals.zoom)});
        }
        if (value.kind === 'constant') {
            return value.value;
        } else {
            return value.evaluate(globals, feature);
        }
    }
}

/**
 * An implementation of `Property` for `*-pattern` and `line-dasharray`, which are transitioned by cross-fading
 * rather than interpolation.
 *
 * @private
 */
class CrossFadedProperty<T> implements Property<T, ?CrossFaded<T>> {
    specification: StylePropertySpecification;

    constructor(specification: StylePropertySpecification) {
        this.specification = specification;
    }

    possiblyEvaluate(value: PropertyValue<T, ?CrossFaded<T>>, parameters: EvaluationParameters): ?CrossFaded<T> {
        if (value.value === undefined) {
            return undefined;
        } else if (value.expression.kind === 'constant') {
            const constant = value.expression.evaluate(parameters);
            return this._calculate(constant, constant, constant, parameters);
        } else {
            assert(!value.isDataDriven());
            return this._calculate(
                value.expression.evaluate({zoom: parameters.zoom - 1.0}),
                value.expression.evaluate({zoom: parameters.zoom}),
                value.expression.evaluate({zoom: parameters.zoom + 1.0}),
                parameters);
        }
    }

    _calculate(min: T, mid: T, max: T, parameters: any): ?CrossFaded<T> {
        const z = parameters.zoom;
        const fraction = z - Math.floor(z);
        const d = parameters.defaultFadeDuration;
        const t = d !== 0 ? Math.min((parameters.now - parameters.zoomHistory.lastIntegerZoomTime) / d, 1) : 1;
        return z > parameters.zoomHistory.lastIntegerZoom ?
            { from: min, to: mid, fromScale: 2, toScale: 1, t: fraction + (1 - fraction) * t } :
            { from: max, to: mid, fromScale: 0.5, toScale: 1, t: 1 - (1 - t) * fraction };
    }

    interpolate(a: ?CrossFaded<T>): ?CrossFaded<T> {
        return a;
    }
}

/**
 * An implementation of `Property` for `heatmap-color`, which has unique evaluation requirements.
 *
 * @private
 */
class HeatmapColorProperty implements Property<Color, RGBAImage> {
    specification: StylePropertySpecification;

    constructor(specification: StylePropertySpecification) {
        this.specification = specification;
    }

    possiblyEvaluate(value: PropertyValue<Color, RGBAImage>, parameters: EvaluationParameters): RGBAImage {
        const colorRampData = new Uint8Array(256 * 4);
        const len = colorRampData.length;
        for (let i = 4; i < len; i += 4) {
            const pxColor = value.expression.evaluate(extend({heatmapDensity: i / len}, parameters));
            // the colors are being unpremultiplied because Color uses
            // premultiplied values, and the Texture class expects unpremultiplied ones
            colorRampData[i + 0] = Math.floor(pxColor.r * 255 / pxColor.a);
            colorRampData[i + 1] = Math.floor(pxColor.g * 255 / pxColor.a);
            colorRampData[i + 2] = Math.floor(pxColor.b * 255 / pxColor.a);
            colorRampData[i + 3] = Math.floor(pxColor.a * 255);
        }
        return RGBAImage.create({width: 256, height: 1}, colorRampData);
    }

    interpolate(a: RGBAImage): RGBAImage {
        return a;
    }
}

module.exports = {
    PropertyValue,
    Transitionable,
    Transitioning,
    Layout,
    PossiblyEvaluatedPropertyValue,
    PossiblyEvaluated,
    DataConstantProperty,
    DataDrivenProperty,
    CrossFadedProperty,
    HeatmapColorProperty
};