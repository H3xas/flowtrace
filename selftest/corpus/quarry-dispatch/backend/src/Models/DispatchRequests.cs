namespace QuarryDispatch.Api.Models
{
    public class DispatchPlanRequest
    {
        public string Serial { get; set; }
    }

    public class DispatchCheckRequest
    {
        public DispatchField Serial { get; set; }
        public DispatchField Origin { get; set; }
        public DispatchField Destination { get; set; }
        public DispatchField Carrier { get; set; }
        public DispatchField Window { get; set; }
        public DispatchField Priority { get; set; }
        public DispatchField Reference { get; set; }
        public DispatchField Warehouse { get; set; }
    }

    public class DispatchField
    {
        public string Value { get; set; }

        public bool IsValid()
        {
            return Value != null && Value.Length > 0;
        }
    }

    public class DispatchRouteRequest
    {
        public string Serial { get; set; }
    }

    public class DispatchSurveyRequest
    {
        public string Serial { get; set; }
    }
}
